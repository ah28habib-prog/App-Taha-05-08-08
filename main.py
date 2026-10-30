import os
import base64
import json
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from groq import Groq
import edge_tts

app = FastAPI()

class VoiceRequest(BaseModel):
    audioBase64: str

# متصل کردن پوشه public برای خواندن فایل‌های HTML
app.mount("/public", StaticFiles(directory="public"), name="public")

@app.get("/")
async def read_index():
    return FileResponse("public/index.html")

@app.post("/api/process-voice")
async def process_voice(req: VoiceRequest):
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="کلید GROQ_API_KEY در تنظیمات Render ست نشده است.")

    # ۱. استخراج صحیح داده‌های Base64 صوتی
    audio_data = req.audioBase64
    if "," in audio_data:
        audio_data = audio_data.split(",")[1]

    try:
        audio_bytes = base64.b64decode(audio_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"فرمت فایل صوتی ناخوانا است: {str(e)}")

    if not audio_bytes:
        raise HTTPException(status_code=400, detail="فایل صوتی خالی است.")

    client = Groq(api_key=api_key)

    # ۲. تبدیل گفتار صوتی به متن با Whisper (پردازش مستقیم در حافظه)
    try:
        transcription = client.audio.transcriptions.create(
            file=("speech.webm", audio_bytes),
            model="whisper-large-v3",
            language="fa"
        )
        user_text = transcription.text.strip() if transcription.text else ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"خطای پردازش صوت: {str(e)}")

    if not user_text:
        return {
            "userText": "",
            "replyText": "صدای شما واضح نبود، لطفاً دوباره بفرمایید.",
            "action": {"type": "NONE", "target": ""},
            "audioBase64": ""
        }

    # ۳. تحلیل قصد کاربر با Llama 3.3
    system_prompt = """You are a smart web app assistant. Respond strictly in valid JSON format.
{
  "replyText": "پاسخ کوتاه و صمیمی به فارسی",
  "action": {
    "type": "NAVIGATE" or "NONE",
    "target": "آدرس صفحه مانند /profile یا /settings"
  }
}
Return JSON strictly."""

    try:
        chat_completion = client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"}
        )
        agent_res = json.loads(chat_completion.choices.message.content)
    except Exception:
        agent_res = {"replyText": "درخواست شما دریافت شد.", "action": {"type": "NONE", "target": ""}}

    # ۴. تولید صدای فارسی پاسخ با Edge-TTS
    audio_b64_out = ""
    try:
        reply_text = agent_res.get("replyText", "انجام شد")
        communicate = edge_tts.Communicate(reply_text, "fa-IR-DilaraNeural")
        tts_bytes = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                tts_bytes += chunk["data"]
        audio_b64_out = base64.b64encode(tts_bytes).decode("utf-8")
    except Exception as e:
        print("TTS Error:", e)

    # ۵. بازگرداندن پاسخ و اکشن برای فرانت‌اند
    return {
        "userText": user_text,
        "replyText": agent_res.get("replyText", "انجام شد"),
        "action": agent_res.get("action", {"type": "NONE", "target": ""}),
        "audioBase64": audio_b64_out
    }
