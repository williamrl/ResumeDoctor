import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import Stripe from 'stripe';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import unzipper from 'unzipper';
import { parseStringPromise } from 'xml2js';
import { Readable } from 'stream';
import multer from 'multer';
import PDFDocument from 'pdfkit';

dotenv.config();

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Developer bypass for testing
const DEVELOPER_USER_ID = 'dev-bypass-123';
const UNLIMITED_TAILORS = 9999;

// Setup multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/debug-parse-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const content = await parseResumeFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    
    res.json({ 
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      file_size: req.file.size,
      extracted_length: content ? content.length : 0,
      extracted_content: content ? content.substring(0, 500) : null,
      success: content ? true : false
    });
  } catch (error) {
    console.error('Debug parse error:', error);
    res.status(500).json({ error: error.message });
  }
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

async function parseDOCX(fileBuffer) {
  try {
    const readable = Readable.from(Buffer.from(fileBuffer));
    const directory = await readable.pipe(unzipper.Parse()).promise();
    
    let xmlContent = '';
    for (const entry of directory) {
      if (entry.path === 'word/document.xml') {
        xmlContent = await entry.buffer();
        break;
      } else {
        entry.autodrain();
      }
    }
    
    if (!xmlContent) return null;
    
    const parsed = await parseStringPromise(xmlContent);
    const paragraphs = parsed.document?.body?.[0]?.p || [];
    
    let text = '';
    for (const para of paragraphs) {
      const runs = para.r || [];
      for (const run of runs) {
        const textContent = run.t?.[0] || '';
        text += textContent;
      }
      text += '\n';
    }
    
    return text.trim();
  } catch (err) {
    console.error('DOCX parse error:', err);
    return null;
  }
}

async function parseResumeFile(fileBuffer, mimeType, filename) {
  try {
    let text = '';
    
    if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
      console.log('Parsing as PDF...');
      const data = await pdfParse(fileBuffer);
      text = data.text;
      console.log('PDF extracted:', text.length, 'characters');
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx')
    ) {
      console.log('Parsing as DOCX...');
      text = await parseDOCX(fileBuffer);
      console.log('DOCX extracted:', text ? text.length : 0, 'characters');
    } else if (mimeType === 'application/msword' || filename.endsWith('.doc')) {
      console.log('Parsing as DOC...');
      text = fileBuffer.toString('utf-8', 0, Math.min(fileBuffer.length, 100000));
    } else if (mimeType === 'text/plain' || filename.endsWith('.txt')) {
      console.log('Parsing as TXT...');
      text = fileBuffer.toString('utf-8');
    } else {
      console.log('Unknown file type:', mimeType);
      return null;
    }
    
    if (!text) {
      console.log('No text extracted');
      return null;
    }
    
    const cleanedText = text.trim();
    return cleanedText.length > 0 ? cleanedText : null;
  } catch (err) {
    console.error('File parse error:', err);
    return null;
  }
}

function stripResume(resume) {
  if (!resume) return '';
  let stripped = resume.replace(/\n{3,}/g, '\n\n').trim();
  let lines = stripped.split('\n').filter(line => line.trim().length > 0);
  return lines.join('\n');
}

function detectTechRole(jobDescription) {
  const techKeywords = ['software', 'engineer', 'developer', 'python', 'javascript', 'java', 'golang', 'rust', 'aws', 'kubernetes', 'docker', 'database', 'backend', 'frontend', 'fullstack', 'devops', 'cloud', 'api', 'microservices', 'react', 'node', 'sql'];
  const lowerDesc = jobDescription.toLowerCase();
  const matches = techKeywords.filter(keyword => lowerDesc.includes(keyword)).length;
  return matches >= 3;
}

// Few-shot examples for context
const fewShotExamples = `
EXAMPLE 1 - GOOD TAILORING (Tech Role):
Original: "Managed team of 5 developers and handled project timelines"
Tailored for "Senior Backend Engineer": "Led team of 5 backend engineers through microservices migration to AWS, ensuring zero downtime and 30% reduction in deployment time"
Why it works: Keeps the truth (team of 5, leadership), adds technical depth matching the role.

EXAMPLE 2 - GOOD TAILORING (Soft Skills Weaving):
Original: "Responsible for communication between teams"
Tailored for "Product Manager": "Facilitated alignment between engineering and product teams, translating technical constraints into user-centric requirements"
Why it works: Implicitly shows communication and collaboration through the action, not by saying "Great Communicator".

EXAMPLE 3 - BAD TAILORING (ATS Breakdown):
DON'T DO: "● Communication Skills & Problem-Solving: Led the team to fix bugs"
DO INSTEAD: "● Diagnosed and resolved critical production bugs by coordinating cross-functional troubleshooting efforts"
`;

async function extractJobRequirements(jobDescription) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.5-flash',
      systemInstruction: `You are an expert recruiter and ATS specialist. Extract and analyze job requirements with precision.
Focus on:
1. Core technical/functional skills (non-negotiable)
2. Nice-to-have qualifications
3. Key responsibilities that reveal the role's true priorities
4. Implicit requirements (e.g., "scale to millions of users" = performance optimization, infrastructure knowledge)

Return a clear, structured analysis that a resume writer can use.`
    });
    
    const result = await model.generateContent(
      `Analyze this job posting and extract the key requirements:

JOB POSTING:
${jobDescription.substring(0, 2000)}

Provide:
1. Job Title: 
2. Core Technical Skills Required:
3. Experience Level Required:
4. Top 5 Key Responsibilities:
5. Hidden/Implicit Requirements:
6. Nice-to-Have Skills:`
    );

    const response = await result.response;
    return response.text();
  } catch (err) {
    console.error('Extract requirements error:', err);
    return jobDescription.substring(0, 500);
  }
}

async function tailorResumeWithRequirements(resume, requirements, jobDescription) {
  try {
    const isTechRole = detectTechRole(jobDescription);
    
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.5-flash',
      systemInstruction: `You are an expert ATS (Applicant Tracking System) optimization specialist and professional resume writer.

CRITICAL CONSTRAINTS FOR RESUME TAILORING:
1. NEVER alter historical facts, metrics, job titles, or dates. If a title is "Senior Software Engineer", it must remain exactly that.
2. NEVER use explicit soft-skill headers in bullet points (e.g., do NOT write "Communication Skills: Led a team").
3. DO weave the target job's requested attributes implicitly into action verbs and framing of REAL achievements.
4. DO maintain ATS compatibility - use clean formatting, standard action verbs, and measurable results.
5. DO preserve the candidate's authentic background and accomplishments.
6. PRESERVE TECHNICAL DEPTH: If the candidate has technical skills, keep them prominent unless explicitly pivoting careers (and even then, suggest functional translations like "Technical Lead" instead of removing context entirely).
7. AVOID clichés: No "go-getter attitude", "passionate about", "thinking outside the box", or vague soft skills.
8. FOCUS on impact: Every bullet should have a measurable result or clear business value.

${fewShotExamples}
`
    });

    const tailoringInstructions = isTechRole
      ? `Tailor for this TECHNICAL role. Preserve all technical skills and depth. Emphasize relevant technologies and architectural decisions.`
      : `Tailor for this NON-TECHNICAL role. Translate technical achievements into business/functional terms. For example, "Led Python microservices migration" becomes "Spearheaded infrastructure modernization project reducing deployment time by 40%".`;

    const result = await model.generateContent(
      `You are tailoring a resume for a specific job. Here are the requirements:

${requirements}

ORIGINAL RESUME:
${resume}

${tailoringInstructions}

OUTPUT INSTRUCTIONS:
1. Return ONLY the tailored resume text
2. Keep the same structure as the original (sections, format)
3. Weave job requirements into existing achievements - don't invent new experiences
4. Ensure ATS compatibility with standard formatting
5. Keep the resume to one page (max 500 words)
6. Each bullet point should be 1-2 sentences with clear impact`
    );

    const response = await result.response;
    return response.text();
  } catch (err) {
    console.error('Tailor resume error:', err);
    throw err;
  }
}

async function generateResumePDF(resumeText) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'letter',
        margin: 40,
        bufferPages: true
      });

      let pdfBuffer = Buffer.alloc(0);
      
      doc.on('data', (chunk) => {
        pdfBuffer = Buffer.concat([pdfBuffer, chunk]);
      });

      doc.on('end', () => {
        resolve(pdfBuffer.toString('base64'));
      });

      doc.on('error', reject);

      const lines = resumeText.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        
        if (!trimmed) {
          doc.moveDown(0.15);
          continue;
        }

        // Section headers (all caps)
        if (/^[A-Z\s]+$/.test(trimmed) && trimmed.length > 3 && !trimmed.includes('|')) {
          doc.moveDown(0.2);
          doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000');
          doc.text(trimmed);
          doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#333333');
          doc.moveDown(0.3);
        }
        // Bullet points
        else if (trimmed.startsWith('●')) {
          doc.fontSize(10).font('Helvetica').fillColor('#000000');
          doc.text(trimmed, { width: 475 });
          doc.moveDown(0.15);
        }
        // Job titles and dates (lines with years)
        else if (trimmed.match(/.*\d{4}.*/) && !trimmed.startsWith('●')) {
          doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000');
          doc.text(trimmed, { width: 475 });
          doc.moveDown(0.2);
        }
        // Regular text
        else {
          doc.fontSize(10).font('Helvetica').fillColor('#000000');
          doc.text(trimmed, { width: 475 });
          doc.moveDown(0.2);
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

app.post('/api/tailor-resume', upload.single('resume'), async (req, res) => {
  try {
    const { userId, jobDescription, jobUrl } = req.body;
    
    console.log('=== TAILOR RESUME REQUEST ===');
    console.log('userId:', userId);
    console.log('jobDescription length:', jobDescription ? jobDescription.length : 0);
    console.log('jobUrl:', jobUrl);
    console.log('file uploaded:', req.file ? 'yes' : 'no');
    
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

    // Parse resume file
    let resumeContent = '';
    if (req.file) {
      console.log('Parsing file:', req.file.originalname, 'Size:', req.file.size, 'MIME:', req.file.mimetype);
      resumeContent = await parseResumeFile(req.file.buffer, req.file.mimetype, req.file.originalname);
      console.log('Resume extracted:', resumeContent ? resumeContent.length : 0, 'characters');
      
      if (!resumeContent) {
        console.log('Failed to extract resume content');
        return res.status(400).json({ error: 'Unable to parse resume file. Please try a PDF or TXT format.' });
      }
    } else {
      console.log('No file uploaded in request');
      return res.status(400).json({ error: 'Please upload a resume file.' });
    }

    const trimmedResume = resumeContent.trim();
    console.log('Trimmed resume length:', trimmedResume.length);
    
    if (trimmedResume.length < 50) {
      return res.status(400).json({ error: 'Resume content is too short (minimum 50 characters). Extracted: ' + trimmedResume.length + ' characters.' });
    }

    let finalJobDescription = jobDescription;
    
    // Extract from URL if provided
    if (jobUrl && !jobDescription) {
      try {
        const response = await fetch(jobUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        const html = await response.text();
        
        // Extract text from HTML
        const text = html
          .replace(/<script[^>]*>.*?<\/script>/gs, '')
          .replace(/<style[^>]*>.*?<\/style>/gs, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        
        if (text && text.length > 200) {
          finalJobDescription = text.substring(0, 3000);
        }
      } catch (err) {
        console.error('URL extraction error:', err);
      }
    }

    // Validate job description
    if (!finalJobDescription || finalJobDescription.trim().length < 50) {
      return res.status(400).json({ 
        error: 'Job description is required. Please paste the full job description.' 
      });
    }

    const strippedResume = stripResume(resumeContent);
    const requirements = await extractJobRequirements(finalJobDescription);
    const tailoredResume = await tailorResumeWithRequirements(strippedResume, requirements, finalJobDescription);

    // Generate PDF
    let pdfBase64 = null;
    try {
      pdfBase64 = await generateResumePDF(tailoredResume);
      console.log('PDF generated successfully');
    } catch (pdfErr) {
      console.error('PDF generation error:', pdfErr);
      // Continue without PDF if it fails
    }

    if (userId !== DEVELOPER_USER_ID) {
      userTailors.set(userId, tailorsAvailable - 1);
    }

    res.json({ 
      success: true, 
      tailoredResume,
      pdfBase64,
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