import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Groq } from 'groq-sdk';
import { EdgeTTS } from 'node-edge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// بررسی وجود کلید API
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error('❌ خطا: کلید GROQ_API_KEY در تنظیمات Render ست نشده است!');
}
const groq = new Groq({ apiKey: apiKey || 'dummy_key' });

app.post('/api/process-voice', async (req, res) => {
  let tempAudioPath = null;

  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'فایل صوتی دریافت نشد' });
    }

    // ۱. استخراج استاندارد داده‌های Base64 و ساخت فایل موقت
    const base64Data = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'فایل صوتی خالی یا خراب است' });
    }

    tempAudioPath = path.join('/tmp', `input_${Date.now()}.webm`);
    fs.writeFileSync(tempAudioPath, buffer);

    // ۲. تبدیل گفتار به متن با Whisper
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempAudioPath),
      model: 'whisper-large-v3',
      language: 'fa',
    });

    const userText = transcription.text?.trim();
    if (!userText) {
      return res.json({
        userText: '',
        replyText: 'صدایتان واضح نبود، لطفاً دوباره تلاش کنید.',
        action: { type: 'NONE', target: '' },
        audioBase64: ''
      });
    }

    console.log('🗣️ متن شناسایی شده کاربر:', userText);

    // ۳. تحلیل قصد کاربر با Llama 3.3
    const systemPrompt = `You are a smart assistant for a web application. You MUST respond strictly in valid JSON format.
The output format must be:
{
  "replyText": "پاسخ کوتاه و صمیمی به زبان فارسی",
  "action": {
    "type": "NAVIGATE" or "NONE",
    "target": "path or target page"
  }
}

Available pages and actions:
- Home page: action "NAVIGATE", target "/"
- Profile page: action "NAVIGATE", target "/profile"
- Settings page: action "NAVIGATE", target "/settings"
- Support page: action "NAVIGATE", target "/support"

If no navigation is requested, use action type "NONE" and target "". Return valid json format.`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });

    const agentResult = JSON.parse(chatCompletion.choices[0].message.content);

    // ۴. ساخت فایل صوتی پاسخ با Edge-TTS
    let audioBase64Output = '';
    try {
      const tts = new EdgeTTS({
        voice: 'fa-IR-DilaraNeural',
        lang: 'fa-IR',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
      });
      const audioBuffer = await tts.synthesize(agentResult.replyText || 'درخواست شما انجام شد.');
      audioBase64Output = audioBuffer.toString('base64');
    } catch (ttsErr) {
      console.error('⚠️ خطا در ساخت صدای پاسخ:', ttsErr);
    }

    // ۵. ارسال نتیجه نهایی
    res.json({
      userText: userText,
      replyText: agentResult.replyText || 'انجام شد.',
      action: agentResult.action || { type: 'NONE', target: '' },
      audioBase64: audioBase64Output
    });

  } catch (error) {
    console.error('❌ خطا در پردازش سرور:', error);
    const errorMsg = error?.message || error?.error?.message || 'خطا در ارتباط با سرویس هوش مصنوعی';
    res.status(500).json({ error: errorMsg });
  } finally {
    // پاکسازی فایل موقت صوتی
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
      try { fs.unlinkSync(tempAudioPath); } catch (e) {}
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
