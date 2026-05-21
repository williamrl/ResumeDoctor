import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const users = new Map();

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
    
    res.json({ success: true, userId, name });
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
    
    res.json({ success: true, userId: user.userId, name: user.name });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Strip resume to essentials only
function stripResume(resume) {
  if (!resume) return '';
  
  // Remove extra whitespace, multiple newlines
  let stripped = resume.replace(/\n{3,}/g, '\n\n').trim();
  
  // Keep only lines with substance (remove empty lines, random formatting)
  let lines = stripped.split('\n').filter(line => line.trim().length > 0);
  
  // Keep first 800 chars (essentials only)
  return lines.join('\n').substring(0, 800);
}

// Extract key job requirements (step 1 - cheap)
async function extractJobRequirements(jobDescription, apiKey) {
  try {
    const client = new Anthropic({ apiKey });
    
    const message = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
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

// Tailor resume (step 2 - uses extracted requirements)
async function tailorResumeWithRequirements(resume, requirements, apiKey) {
  try {
    const client = new Anthropic({ apiKey });
    
    const message = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
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

// Main tailor endpoint
app.post('/api/tailor-resume', async (req, res) => {
  try {
    const { userId, resumeContent, jobDescription, jobUrl, apiKey } = req.body;
    
    if (!userId || !apiKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let finalJobDescription = jobDescription;
    
    // Extract from URL if provided
    if (jobUrl && !jobDescription) {
      try {
        const response = await fetch(jobUrl);
        const html = await response.text();
        // Basic extraction - get first 2000 chars of text content
        finalJobDescription = html.substring(0, 2000);
      } catch (err) {
        return res.status(400).json({ error: 'Could not extract job from URL. Please paste description.' });
      }
    }

    if (!finalJobDescription) {
      return res.status(400).json({ error: 'Please provide job description or URL' });
    }

    const user = users.get(Array.from(users.entries()).find(([, u]) => u.userId === userId)?.[0]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Strip resume to essentials
    const strippedResume = stripResume(resumeContent);

    // Step 1: Extract requirements (cheap)
    const requirements = await extractJobRequirements(finalJobDescription, apiKey);

    // Step 2: Tailor resume (uses requirements instead of full job description)
    const tailoredResume = await tailorResumeWithRequirements(strippedResume, requirements, apiKey);

    res.json({ success: true, tailoredResume });
    
  } catch (error) {
    console.error('Error:', error);
    
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