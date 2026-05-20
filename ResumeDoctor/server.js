import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
const client = new Anthropic();

// Middleware
app.use(cors());
app.use(express.json());

// Simple in-memory storage
const users = new Map();
const userStats = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

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
    userStats.set(userId, { used: 0, limit: 2, plan: 'free' });
    
    res.json({ 
      success: true, 
      userId, 
      name,
      plan: 'free',
      limit: 2,
      used: 0
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
    
    const stats = userStats.get(user.userId);
    
    res.json({ 
      success: true, 
      userId: user.userId, 
      name: user.name,
      plan: stats.plan,
      limit: stats.limit,
      used: stats.used
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Tailor resume
app.post('/api/tailor-resume', async (req, res) => {
  try {
    const { userId, resumeContent, jobDescription } = req.body;
    
    if (!userId || !resumeContent || !jobDescription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const stats = userStats.get(userId);
    
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (stats.plan === 'free' && stats.used >= stats.limit) {
      return res.status(403).json({ 
        error: 'Free limit reached',
        used: stats.used,
        limit: stats.limit
      });
    }
    
    const prompt = `You are an expert resume writer. Tailor this resume to match the job requirements perfectly.

ORIGINAL RESUME:
${resumeContent}

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
    
    // Update stats
    stats.used += 1;
    userStats.set(userId, stats);
    
    res.json({
      success: true,
      tailoredResume,
      used: stats.used,
      limit: stats.limit,
      remaining: Math.max(0, stats.limit - stats.used)
    });
    
  } catch (error) {
    console.error('Tailor resume error:', error);
    res.status(500).json({ error: 'Error tailoring resume' });
  }
});

// Get user stats
app.get('/api/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const stats = userStats.get(userId);
    
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      plan: stats.plan,
      used: stats.used,
      limit: stats.limit,
      remaining: Math.max(0, stats.limit - stats.used)
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});