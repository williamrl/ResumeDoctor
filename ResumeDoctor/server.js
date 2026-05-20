import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();

const corsOptions = {
  origin: '*',
  credentials: true,
};

app.use(cors(corsOptions));
// Enable preflight across the board
app.options('*', cors(corsOptions));

app.use(express.json());

// Mock user storage (in production, use real database)
const users = new Map();
const userLimits = new Map();

// Simple in-memory token bucket for rate limiting
const rateLimits = new Map();

function checkRateLimit(userId, limit = 100) {
  const now = Date.now();
  const userLimit = rateLimits.get(userId) || { tokens: limit, lastRefill: now };
  
  const timePassed = (now - userLimit.lastRefill) / 1000;
  userLimit.tokens = Math.min(limit, userLimit.tokens + timePassed * (limit / 3600));
  userLimit.lastRefill = now;
  
  if (userLimit.tokens >= 1) {
    userLimit.tokens -= 1;
    rateLimits.set(userId, userLimit);
    return true;
  }
  
  return false;
}

// Register user
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  if (users.has(email)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  
  const userId = Date.now().toString();
  users.set(email, { id: userId, email, password, name });
  userLimits.set(userId, { free: 2, used: 0, plan: 'free' });
  
  res.json({ 
    success: true, 
    userId, 
    email,
    plan: 'free',
    limit: 2
  });
});

// Login user
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  
  const user = users.get(email);
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const limits = userLimits.get(user.id);
  
  res.json({ 
    success: true, 
    userId: user.id, 
    email: user.email,
    name: user.name,
    plan: limits.plan,
    limit: limits.free,
    used: limits.used
  });
});

// Tailor resume endpoint
app.post('/api/tailor-resume', (req, res) => {
  const { userId, resumeContent, jobDescription } = req.body;
  
  if (!userId || !resumeContent || !jobDescription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Check rate limit
  if (!checkRateLimit(userId)) {
    return res.status(429).json({ error: 'Rate limited. Please wait.' });
  }
  
  const limits = userLimits.get(userId);
  
  if (limits.plan === 'free' && limits.used >= limits.free) {
    return res.status(403).json({ 
      error: 'Free limit reached', 
      used: limits.used,
      limit: limits.free
    });
  }
  
  // Call Claude API
  (async () => {
    try {
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
7. Return ONLY the tailored resume text, no explanations or preamble

Return the tailored resume now:`;

      const message = await client.messages.create({
        model: 'claude-opus-4-1',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const tailoredResume = message.content[0].text;
      
      // Update usage
      limits.used += 1;
      userLimits.set(userId, limits);
      
      res.json({
        success: true,
        tailoredResume,
        used: limits.used,
        limit: limits.free,
        remaining: Math.max(0, limits.free - limits.used)
      });
      
    } catch (error) {
      console.error('Claude API error:', error);
      res.status(500).json({ error: 'Error tailoring resume. Please try again.' });
    }
  })();
});

// Get user stats
app.get('/api/user/:userId', (req, res) => {
  const { userId } = req.params;
  const limits = userLimits.get(userId);
  
  if (!limits) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    plan: limits.plan,
    used: limits.used,
    limit: limits.free,
    remaining: Math.max(0, limits.free - limits.used)
  });
});

// Upgrade to premium
app.post('/api/upgrade/:userId', (req, res) => {
  const { userId } = req.params;
  const limits = userLimits.get(userId);
  
  if (!limits) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  limits.plan = 'premium';
  limits.free = 999999; // Unlimited
  userLimits.set(userId, limits);
  
  res.json({
    success: true,
    plan: 'premium',
    limit: 999999,
    remaining: 999999 - limits.used
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
