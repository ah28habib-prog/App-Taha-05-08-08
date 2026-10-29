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
  console.error('❌ کلید GROQ_API_KEY در Environment متغیرهای Render تعریف نشده است!');
}

const groq = new Groq({ apiKey: apiKey || '' });

app.post('/api/process-voice', async (req, res) => {
  let tempAudioPath = null;

  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'فایل صوتی از فرانت‌اند دریافت نشد.' });
    }

    // ۱. تشخیص هوشمند فرمت صوتی (آیفون vs اندروید)
    let fileExtension = 'webm';
    if (audioBase64.includes('audio/mp4') || audioBase64.includes('audio/aac') || audioBase64.includes('audio/m4a')) {
      fileExtension = 'mp4';
    } else if (audioBase64.includes('audio/ogg')) {
      fileExtension = 'ogg';
    }

    // استخراج Base64 خالص
    const base64Data = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'فایل صوتی خالی یا نامعتبر است.' });
    }

    tempAudioPath = path.join('/tmp', `input_${Date.now()}.${fileExtension}`);
    fs.writeFileSync(tempAudioPath, buffer);

    // ۲. تبدیل گفتار به متن با Whisper (با مدیریت خطای مجزا)
    let transcription;
    try {
      transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tempAudioPath),
        model: 'whisper-large-v3',
        language: 'fa',
      });
    } catch (whisperErr) {
      console.error('❌ خطای Groq Whisper:', whisperErr);
      const detail = whisperErr?.error?.message || whisperErr?.message || 'مشکل در کلید API یا فرمت فایل صوتی';
      return res.status(500).json({ error: `خطای Whisper: ${detail}` });
    }

    const userText = transcription.text?.trim();
    if (!userText) {
      return res.json({
        userText: '',
        replyText: 'صدای شما واضح نبود، لطفاً مجدداً تلاش کنید.',
        action: { type: 'NONE', target: '' },
        audioBase64: ''
      });
    }

    console.log('🗣️ متن کاربر:', userText);

    // ۳. تحلیل قصد کاربر با Llama 3.3
    const systemPrompt = `You are a helpful AI assistant for a web app. Respond ONLY in valid JSON.
{
  "replyText": "پاسخ کوتاه به فارسی",
  "action": {
    "type": "NAVIGATE" or "NONE",
    "target": "path"
  }
}
Available pages: "/", "/profile", "/settings", "/support".`;

    let agentResult = { replyText: 'درخواست شما دریافت شد.', action: { type: 'NONE', target: '' } };
    try {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText }
        ],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' }
      });
      agentResult = JSON.parse(chatCompletion.choices.message.content);
    } catch (llmErr) {
      console.error('❌ خطای Groq Llama:', llmErr);
      agentResult.replyText = 'متن دریافت شد اما در تحلیل اکشن خطایی رخ داد.';
    }

    // ۴. تبدیل پاسخ متنی به صوت با Edge-TTS (به‌صورت ایمن)
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
      console.error('⚠️ خطای تولید صدای مایکروسافت (غیر بحرانی):', ttsErr);
    }

    // ۵. ارسال خروجی
    res.json({
      userText: userText,
      replyText: agentResult.replyText || 'انجام شد',
      action: agentResult.action || { type: 'NONE', target: '' },
      audioBase64: audioBase64Output
    });

  } catch (error) {
    console.error('❌ خطای ناشناخته سرور:', error);
    res.status(500).json({ error: error?.message || 'خطای غیرمنتظره روی سرور' });
  } finally {
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
      try { fs.unlinkSync(tempAudioPath); } catch (e) {}
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
