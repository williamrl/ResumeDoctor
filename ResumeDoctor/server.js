import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();

// Middleware with higher limits
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Simple in-memory storage
const users = new Map();

// Register
app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    
    if (users.has(email)) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const userId = Date.now().toString();
    users.set(email, { userId, name, password });
    
    res.json({ 
      success: true, 
      userId, 
      name
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    
    const user = users.get(email);
    
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    res.json({ 
      success: true, 
      userId: user.userId, 
      name: user.name
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Tailor resume with user's API key
app.post('/api/tailor-resume', async (req, res) => {
  try {
    const { userId, resumeContent, jobDescription, apiKey } = req.body;
    
    if (!userId || !jobDescription || !apiKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const user = users.get(Array.from(users.entries()).find(([, u]) => u.userId === userId)?.[0]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Use user's API key
    const client = new Anthropic({
      apiKey: apiKey
    });

    const prompt = `You are an expert resume writer. Tailor this resume to match the job requirements perfectly.

${resumeContent ? `ORIGINAL RESUME:
${resumeContent}` : 'NO RESUME PROVIDED - Create a professional resume format'}

JOB DESCRIPTION:
${jobDescription}

INSTRUCTIONS:
1. Mirror keywords and requirements from the job description
2. Reorder bullet points to emphasize relevant experience first
3. Use action verbs that match the job's tone
4. Keep all information truthful - only reframe and reorganize
5. Optimize for ATS - use standard formatting, no special characters
6. Keep to one page if possible, maximum two pages
7. Return ONLY the tailored resume text, no explanations

Return the tailored resume now:`;

    const message = await client.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const tailoredResume = message.content[0].text;

    res.json({
      success: true,
      tailoredResume
    });
    
  } catch (error) {
    console.error('Tailor resume error:', error);
    
    if (error.status === 401) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    res.status(500).json({ error: error.message || 'Error tailoring resume' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});