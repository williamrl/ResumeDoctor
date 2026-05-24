import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import * as cheerio from 'cheerio';

dotenv.config();

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Developer bypass for testing
const DEVELOPER_USER_ID = 'dev-bypass-123';
const UNLIMITED_TAILORS = 9999;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const users = new Map();
const userTailors = new Map();

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    
    if (users.has(email)) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const userId = email === 'dev@test.com' ? DEVELOPER_USER_ID : Date.now().toString();
    users.set(email, { userId, name, password });
    
    const tailorsAvailable = email === 'dev@test.com' ? UNLIMITED_TAILORS : 0;
    userTailors.set(userId, tailorsAvailable);
    
    res.json({ success: true, userId, name, tailorsAvailable });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

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
    
    const tailorsAvailable = userTailors.get(user.userId) || 0;
    
    res.json({ 
      success: true, 
      userId: user.userId, 
      name: user.name,
      tailorsAvailable
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing user ID' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}?payment=success&userId=${userId}`,
      cancel_url: process.env.FRONTEND_URL,
      metadata: { userId }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata.userId;
      
      const currentTailors = userTailors.get(userId) || 0;
      userTailors.set(userId, currentTailors + 1);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Webhook failed' });
  }
});

app.get('/api/user/:userId/tailors', (req, res) => {
  try {
    const { userId } = req.params;
    const tailorsAvailable = userTailors.get(userId) || 0;
    
    res.json({ tailorsAvailable });
  } catch (error) {
    console.error('Get tailors error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

function stripResume(resume) {
  if (!resume) return '';
  let stripped = resume.replace(/\n{3,}/g, '\n\n').trim();
  let lines = stripped.split('\n').filter(line => line.trim().length > 0);
  return lines.join('\n').substring(0, 800);
}

async function extractJobDescriptionFromUrl(jobUrl) {
  try {
    const response = await fetch(jobUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const html = await response.text();
    
    // Parse with cheerio
    const $ = cheerio.load(html);
    
    // Remove script and style tags
    $('script').remove();
    $('style').remove();
    
    // Get text content
    let text = $.text();
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    return text.substring(0, 3000);
  } catch (err) {
    console.error('URL extraction error:', err);
    return null;
  }
}

async function extractJobRequirements(jobDescription) {
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Extract ONLY the key job requirements from this job posting. List: job title, required skills, experience level, key responsibilities.

JOB POSTING:
${jobDescription.substring(0, 1500)}`
      }]
    });

    return message.content[0].text;
  } catch (err) {
    console.error('Extract requirements error:', err);
    return jobDescription.substring(0, 500);
  }
}

async function tailorResumeWithRequirements(resume, requirements) {
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are a professional resume writer. Tailor the resume below to match the job requirements exactly. Emphasize relevant skills and experience. Keep it to one page max. Return ONLY the tailored resume text.

JOB REQUIREMENTS:
${requirements}

ORIGINAL RESUME:
${resume}`
      }]
    });

    return message.content[0].text;
  } catch (err) {
    console.error('Tailor resume error:', err);
    throw err;
  }
}

app.post('/api/tailor-resume', async (req, res) => {
  try {
    const { userId, resumeContent, jobDescription, jobUrl } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing user ID' });
    }

    let tailorsAvailable;
    if (userId === DEVELOPER_USER_ID) {
      tailorsAvailable = UNLIMITED_TAILORS;
    } else {
      tailorsAvailable = userTailors.get(userId) || 0;
      if (tailorsAvailable <= 0) {
        return res.status(403).json({ error: 'No tailors available. Purchase one first.' });
      }
    }

    let finalJobDescription = jobDescription;
    
    // Extract from URL if provided
    if (jobUrl && !jobDescription) {
      const extractedJob = await extractJobDescriptionFromUrl(jobUrl);
      if (extractedJob) {
        finalJobDescription = extractedJob;
      }
    }

    // Require job description
    if (!finalJobDescription || finalJobDescription.trim().length < 100) {
      return res.status(400).json({ error: 'Could not extract job description from URL or no description provided. Please paste the job description directly.' });
    }

    // Resume validation
    if (!resumeContent || resumeContent.trim().length < 50) {
      return res.status(400).json({ error: 'Resume content is too short or empty.' });
    }

    const strippedResume = stripResume(resumeContent);
    const requirements = await extractJobRequirements(finalJobDescription);
    const tailoredResume = await tailorResumeWithRequirements(strippedResume, requirements);

    if (userId !== DEVELOPER_USER_ID) {
      userTailors.set(userId, tailorsAvailable - 1);
    }

    res.json({ 
      success: true, 
      tailoredResume,
      tailorsRemaining: userId === DEVELOPER_USER_ID ? UNLIMITED_TAILORS : tailorsAvailable - 1
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message || 'Error tailoring resume' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});