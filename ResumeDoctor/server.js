import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';

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

async function extractJobRequirements(jobDescription) {
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-3-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Extract ONLY the key requirements from this job. List: title, required skills, experience level, key responsibilities.

JOB:
${jobDescription.substring(0, 1000)}`
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
      model: 'claude-haiku-3-5',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Tailor resume to match these job requirements. One page. Return ONLY the tailored resume.

REQUIREMENTS:
${requirements}

RESUME:
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
    
    if (jobUrl && !jobDescription) {
      try {
        const response = await fetch(jobUrl);
        const html = await response.text();
        finalJobDescription = html.substring(0, 2000);
      } catch (err) {
        return res.status(400).json({ error: 'Could not extract job from URL. Please paste description.' });
      }
    }

    if (!finalJobDescription) {
      return res.status(400).json({ error: 'Please provide job description or URL' });
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