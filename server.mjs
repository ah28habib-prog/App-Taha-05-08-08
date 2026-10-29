import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Groq } from 'groq-sdk';
import { EdgeTTS } from 'node-edge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// مسیر پردازش صوت و تبدیل به اکشن + صدای پاسخ
app.post('/api/process-voice', async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) return res.status(400).json({ error: 'فایلی ارسال نشده است' });

    // ۱. ذخیره موقت فایل صوتی در سرور
    const buffer = Buffer.from(audioBase64.split(',')[1] || audioBase64, 'base64');
    const tempAudioPath = path.join('/tmp', `input_${Date.now()}.webm`);
    fs.writeFileSync(tempAudioPath, buffer);

    // ۲. تبدیل گفتار فارسی به متن با Whisper در Groq
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempAudioPath),
      model: 'whisper-large-v3',
      language: 'fa',
    });
    const userText = transcription.text;
    fs.unlinkSync(tempAudioPath); // پاک کردن فایل موقت

    console.log('متن کاربر:', userText);

    // ۳. تحلیل قصد کاربر و تشخیص اکشن برنامه با Llama 3.3
    const systemPrompt = `
تو یک ایجنت هوشمند برای مدیریت اپلیکیشن وب هستی.
وظیفه تو این است که متن کاربر را ببینی و تصمیم بگیری چه اکشنی در برنامه باید انجام شود.

صفحات و اکشن‌های موجود در برنامه:
- صفحه اصلی (Home): action: "NAVIGATE", target: "/"
- صفحه پروفایل (Profile): action: "NAVIGATE", target: "/profile"
- صفحه تنظیمات (Settings): action: "NAVIGATE", target: "/settings"
- صفحه تماس/پشتیبانی (Support): action: "NAVIGATE", target: "/support"
- تغییر تم به تاریک/روشن: action: "TOGGLE_THEME", target: "dark" یا "light"

خروجی تو باید حتماً به فرمت JSON معتبر زیر باشد و هیچ متن دیگری اضافه نکن:
{
  "replyText": "پاسخ کوتاه و صمیمی به فارسی به کاربر",
  "action": {
    "type": "NAVIGATE" یا "TOGGLE_THEME" یا "NONE",
    "target": "آدرس صفحه یا پارامتر اکشن"
  }
}
`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(chatCompletion.choices[0].message.content);

    // ۴. تولید صدای فارسی پاسخ با Edge-TTS
    const tts = new EdgeTTS({
      voice: 'fa-IR-DilaraNeural',
      lang: 'fa-IR',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
    });

    const audioBuffer = await tts.synthesize(result.replyText);
    const audioBase64Output = audioBuffer.toString('base64');

    // ۵. ارسال پاسخ متنی، اکشن برنامه‌ای و فایل صوتی به فرانت‌اند
    res.json({
      userText: userText,
      replyText: result.replyText,
      action: result.action,
      audioBase64: audioBase64Output
    });

  } catch (error) {
    console.error('Error processing:', error);
    res.status(500).json({ error: 'خطا در پردازش دستیار صوتی' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
