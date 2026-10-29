import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Groq, toFile } from 'groq-sdk';
import { EdgeTTS } from 'node-edge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/process-voice', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'کلید GROQ_API_KEY در تنظیمات Render ست نشده است.' });
    }

    const { audioBase64 } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'فایل صوتی دریافت نشد.' });
    }

    // ۱. استخراج داده‌های Base64 و ساخت بفر
    const base64Parts = audioBase64.split(',');
    const pureBase64 = base64Parts.length > 1 ? base64Parts[1] : base64Parts[0];
    const buffer = Buffer.from(pureBase64, 'base64');

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'حجم فایل صوتی صفر است.' });
    }

    // ۲. تشخیص پسوند فایل بر اساس MimeType
    let fileName = 'speech.webm';
    if (audioBase64.includes('audio/mp4') || audioBase64.includes('audio/aac') || audioBase64.includes('audio/m4a')) {
      fileName = 'speech.mp4';
    }

    const groq = new Groq({ apiKey });

    // ۳. تبدیل صوت به متن با Whisper (با استفاده از toFile)
    const audioFile = await toFile(buffer, fileName);
    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3',
      language: 'fa',
    });

    const userText = transcription.text?.trim();
    if (!userText) {
      return res.json({
        userText: '',
        replyText: 'صدای شما واضح نبود، دوباره تلاش کنید.',
        action: { type: 'NONE', target: '' },
        audioBase64: ''
      });
    }

    console.log('🗣️ متن کاربر:', userText);

    // ۴. تحلیل قصد کاربر با Llama 3.3
    const systemPrompt = `You are an AI assistant for a web app. Respond ONLY in valid JSON.
Format:
{
  "replyText": "پاسخ کوتاه به فارسی",
  "action": { "type": "NAVIGATE" or "NONE", "target": "path" }
}
Return json format.`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });

    let agentResult = { replyText: 'درخواست انجام شد.', action: { type: 'NONE', target: '' } };
    try {
      agentResult = JSON.parse(chatCompletion.choices.message.content);
    } catch (e) {
      console.error('خطا در پارس JSON:', e);
    }

    // ۵. تولید صدای پاسخ با Edge-TTS
    let audioBase64Output = '';
    try {
      const tts = new EdgeTTS({
        voice: 'fa-IR-DilaraNeural',
        lang: 'fa-IR',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
      });
      const audioBuffer = await tts.synthesize(agentResult.replyText || 'انجام شد');
      audioBase64Output = audioBuffer.toString('base64');
    } catch (ttsErr) {
      console.warn('هشدار TTS:', ttsErr.message);
    }

    res.json({
      userText: userText,
      replyText: agentResult.replyText,
      action: agentResult.action,
      audioBase64: audioBase64Output
    });

  } catch (error) {
    console.error('❌ خطای کامل سرور:', error);
    // بازگرداندن متن دقیق ارور برای تشخیص سریع
    const errorMessage = error?.error?.message || error?.message || JSON.stringify(error);
    res.status(500).json({ error: `خطای سرور: ${errorMessage}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
});
