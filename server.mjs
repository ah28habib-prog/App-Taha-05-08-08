import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// دریافت پیام متنی
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'کلید تنظیم نشده است' });

    const { message } = req.body;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const result = await model.generateContent(message);
    const response = await result.response;
    res.json({ reply: response.text() });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'خطا در ارتباط با هوش مصنوعی' });
  }
});

// دریافت صدای ضبط شده مستقیم از میکروفون گوشی
app.post('/api/chat-audio', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'کلید تنظیم نشده است' });

    const { audioBase64, mimeType } = req.body;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const audioPart = {
      inlineData: {
        data: audioBase64,
        mimeType: mimeType || 'audio/webm'
      }
    };

    const prompt = "صدای کاربر را گوش کن و پاسخی روان، کوتاه و صمیمانه به زبان فارسی بده.";
    const result = await model.generateContent([prompt, audioPart]);
    const response = await result.response;
    
    res.json({ reply: response.text() });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'خطا در پردازش صدا توسط Gemini' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
