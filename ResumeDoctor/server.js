import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
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

const DEVELOPER_USER_ID = 'dev-bypass-123';
const UNLIMITED_TAILORS = 9999;

const upload = multer({ storage: multer.memoryStorage() });

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
    res.json({ success: true, userId: user.userId, name: user.name, tailorsAvailable });
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
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
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
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
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

// ============= FILE PARSING =============

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
      const data = await pdfParse(fileBuffer);
      text = data.text;
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || filename.endsWith('.docx')) {
      text = await parseDOCX(fileBuffer);
    } else if (mimeType === 'text/plain' || filename.endsWith('.txt')) {
      text = fileBuffer.toString('utf-8');
    } else {
      return null;
    }
    if (!text) return null;
    return text.trim().length > 0 ? text.trim() : null;
  } catch (err) {
    console.error('File parse error:', err);
    return null;
  }
}

// ============= TEXT SANITIZATION =============

function deepSanitize(text) {
  if (!text) return '';
  
  // Remove known bad sequences
  text = text.replace(/%Ï/g, '').replace(/Ã¯/g, '').replace(/â\x80/g, '');
  text = text.replace(/â/g, '').replace(/€™/g, '').replace(/€/g, '');
  text = text.replace(/™/g, '').replace(/Â/g, '');
  
  // Normalize unicode and keep only printable ASCII
  try { text = text.normalize('NFKD'); } catch (e) {}
  text = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  
  // Remove problematic characters
  text = text.replace(/[•·○◦◆◎☐✓★©®†‡≠]/g, '');
  
  // Fix escaped characters
  text = text.replace(/\\\$/g, '$').replace(/\\\*/g, '*').replace(/\\\-/g, '-');
  
  // Clean spacing per line
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].trim().replace(/\s+/g, ' ');
  }
  text = lines.join('\n');
  
  // Normalize line endings and blank lines
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  
  return text.trim();
}

// Apply ONLY to body text (bullets, summary) - NOT to phone numbers or dates
function polishBodyNumbers(text) {
  if (!text) return '';
  
  // Convert 'X percent' to 'X%'
  text = text.replace(/(\d+(?:\.\d+)?)\s+percent/gi, '$1%');
  
  // Convert 'X dollars' to '$X' with commas
  text = text.replace(/(\d+)\s+dollars/gi, (match, num) => {
    return '$' + parseInt(num).toLocaleString();
  });
  
  // Convert 'X million' to 'XM' or '$XM' if preceded by $
  text = text.replace(/(\d+(?:\.\d+)?)\s+million/gi, '$1M');
  
  // Convert 'X thousand' to comma-formatted number
  text = text.replace(/(\d+)\s+thousand/gi, (match, num) => {
    return (parseInt(num) * 1000).toLocaleString();
  });
  
  // Format standalone large numbers (5+ digits, not in phone/date context)
  // Only format if surrounded by word boundaries and not part of a longer number string
  text = text.replace(/(?<![\d\-\(\)])(\d{5,})(?![\d\-\)])/g, (match) => {
    return parseInt(match).toLocaleString();
  });
  
  return text;
}

function stripResume(resume) {
  if (!resume) return '';
  resume = deepSanitize(resume);
  let stripped = resume.replace(/\n{3,}/g, '\n\n').trim();
  return stripped;
}

function detectTechRole(jobDescription) {
  const techKeywords = ['software', 'engineer', 'developer', 'python', 'javascript', 'java', 'golang', 'rust', 'aws', 'kubernetes', 'docker', 'database', 'backend', 'frontend', 'fullstack', 'devops', 'cloud', 'api', 'microservices', 'react', 'node', 'sql'];
  const lowerDesc = jobDescription.toLowerCase();
  const matches = techKeywords.filter(keyword => lowerDesc.includes(keyword)).length;
  return matches >= 3;
}

// ============= GEMINI API CALLS =============

async function extractJobRequirements(jobDescription) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.5-flash',
      systemInstruction: `You are an expert recruiter and ATS specialist. Extract job requirements with precision.`
    });
    
    const result = await model.generateContent(
      `Analyze this job posting and extract key requirements:

JOB POSTING:
${jobDescription.substring(0, 3000)}

Provide:
1. Job Title
2. Core Technical/Functional Skills Required
3. Experience Level Required
4. Top 5 Key Responsibilities
5. Industry Keywords for ATS
6. Soft Skills Needed`
    );

    return result.response.text();
  } catch (err) {
    console.error('Extract requirements error:', err);
    return jobDescription.substring(0, 500);
  }
}

// STRICT SCHEMA - ALL sections required
const tailoredResumeSchema = {
  type: 'object',
  properties: {
    contact_info: {
      type: 'object',
      description: 'EXTRACT FROM ORIGINAL RESUME - do not invent or use placeholders',
      properties: {
        full_name: { type: 'string', description: 'Full name from original resume' },
        location: { type: 'string', description: 'City, State from original resume' },
        phone: { type: 'string', description: 'Phone number from original resume' },
        email: { type: 'string', description: 'Email from original resume' },
        linkedin: { type: 'string', description: 'LinkedIn URL from original resume, empty string if not present' }
      },
      required: ['full_name', 'location', 'phone', 'email']
    },
    professional_summary: {
      type: 'string',
      description: '3-4 sentence summary based on actual experience in the resume'
    },
    experience: {
      type: 'array',
      description: 'ALL jobs from original resume - do not drop any positions',
      items: {
        type: 'object',
        properties: {
          job_title: { type: 'string', description: 'EXACT job title from original - do not change' },
          company: { type: 'string', description: 'EXACT company name from original - do not change' },
          location: { type: 'string' },
          date_range: { type: 'string' },
          bullet_points: {
            type: 'array',
            items: { type: 'string' },
            description: '3-4 reworded bullets per job. Use $50,000 not 50000 dollars. Use 35% not 35 percent.'
          }
        },
        required: ['job_title', 'company', 'date_range', 'bullet_points']
      }
    },
    skills: {
      type: 'array',
      description: 'Skills FROM the original resume, regrouped/reworded to match job. Do NOT invent skills.',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } }
        },
        required: ['category', 'items']
      }
    },
    education: {
      type: 'array',
      description: 'ALL education from original resume',
      items: {
        type: 'object',
        properties: {
          degree: { type: 'string' },
          school: { type: 'string' },
          graduation_date: { type: 'string' },
          details: { type: 'string' }
        },
        required: ['degree', 'school']
      }
    },
    certifications: {
      type: 'array',
      description: 'ALL certifications from original resume',
      items: { type: 'string' }
    }
  },
  required: ['contact_info', 'professional_summary', 'experience', 'skills', 'education']
};

async function tailorResumeWithRequirements(resume, requirements, jobDescription) {
  try {
    const isTechRole = detectTechRole(jobDescription);
    
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.5-flash',
      systemInstruction: `You are a professional resume editor that performs ATS keyword optimization.

ABSOLUTE RULES - VIOLATING THESE INVALIDATES THE RESUME:

1. PRESERVE FACTS: Job titles, company names, dates, education, and certifications MUST stay EXACTLY as they appear in the original resume. Never change "Senior Software Engineer" to "Senior Sales Engineer" or rename companies.

2. NO HALLUCINATION: NEVER invent skills, tools, or experiences not present in the original resume. If the candidate has Python and SQL, do not add Salesforce or HubSpot.

3. INCLUDE ALL SECTIONS: You MUST include contact_info, professional_summary, experience (all jobs), skills, education, and certifications. Do not drop sections.

4. EXTRACT CONTACT INFO: Pull the actual name, location, phone, email, and LinkedIn from the original resume. NEVER use placeholders like "YOUR NAME" or "email@example.com".

5. REWORD, DON'T REPLACE: You may reword bullet points to emphasize relevant aspects, but the underlying facts (technologies, metrics, scope) must remain the same.

6. NUMERIC FORMATTING: Always use numeric symbols. Write "$50,000" not "50000 dollars". Write "35%" not "35 percent". Write "2M+" not "2 million".

7. ASCII ONLY: Output clean English text with standard ASCII characters only. No special characters, no markdown bullets, no unicode symbols.

8. ATS KEYWORDS: Naturally weave job posting keywords into the existing bullets. Do not add a "Keywords" section.

EXAMPLE OF CORRECT REWORDING:
Original: "Built RESTful APIs using Node.js and Express, serving 2M+ monthly active users"
For a Backend Engineer role: "Architected high-throughput RESTful APIs with Node.js and Express, supporting 2M+ monthly active users"
(Same facts, slightly different emphasis matching the role)

EXAMPLE OF WHAT NOT TO DO:
Original: "Built RESTful APIs using Node.js and Express, serving 2M+ monthly active users"
WRONG for Sales role: "Generated leads and managed sales territories serving 2M+ clients"
(This is fabrication - the candidate never did sales)`
    });

    const roleType = isTechRole ? 'TECHNICAL role' : 'business/non-technical role';
    
    const prompt = `Tailor this resume for the job below. Follow ALL absolute rules from your system instruction.

JOB REQUIREMENTS:
${requirements}

ORIGINAL RESUME (preserve all facts from this):
${resume}

This is a ${roleType}. ${isTechRole 
  ? 'Keep all technical depth and stack. Emphasize technologies that match the job.' 
  : 'Reframe technical achievements in business terms (impact, scale, leadership) while keeping the actual roles and technologies intact.'}

CHECKLIST before responding:
- Did I extract the real contact info (name, phone, email)?
- Did I include EVERY job from the original?
- Did I keep EXACT job titles and company names?
- Did I include education and certifications?
- Are all skills from the original resume (not invented)?
- Did I use $50,000 format not "50000 dollars"?

Return ONLY valid JSON matching the schema.`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: tailoredResumeSchema,
        temperature: 0.3  // Lower temp = less creative = less hallucination
      }
    });

    const jsonText = result.response.text();
    
    let resumeData;
    try {
      resumeData = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse JSON:', e);
      console.error('Raw response:', jsonText.substring(0, 500));
      throw new Error('AI response was malformed');
    }

    return formatResumeFromJSON(resumeData);
  } catch (err) {
    console.error('Tailor resume error:', err);
    throw err;
  }
}

function formatResumeFromJSON(data) {
  let output = '';

  // CONTACT HEADER
  if (data.contact_info) {
    const c = data.contact_info;
    const name = deepSanitize(c.full_name || '').toUpperCase();
    output += name + '\n';
    
    const contactParts = [];
    if (c.location) contactParts.push(deepSanitize(c.location));
    if (c.phone) contactParts.push(deepSanitize(c.phone));
    if (c.email) contactParts.push(deepSanitize(c.email));
    if (c.linkedin) contactParts.push(deepSanitize(c.linkedin));
    
    output += contactParts.join(' | ') + '\n\n';
  }

  // PROFESSIONAL SUMMARY
  if (data.professional_summary) {
    output += 'PROFESSIONAL SUMMARY\n';
    const summary = polishBodyNumbers(deepSanitize(data.professional_summary));
    output += summary + '\n\n';
  }

  // EXPERIENCE
  if (data.experience && Array.isArray(data.experience) && data.experience.length > 0) {
    output += 'EXPERIENCE\n\n';
    for (const job of data.experience) {
      const title = deepSanitize(job.job_title || '');
      const company = deepSanitize(job.company || '');
      const location = deepSanitize(job.location || '');
      const dateRange = deepSanitize(job.date_range || '');
      
      output += `${title} | ${company}\n`;
      
      const subParts = [];
      if (location) subParts.push(location);
      if (dateRange) subParts.push(dateRange);
      if (subParts.length > 0) {
        output += subParts.join(' | ') + '\n';
      }
      
      if (job.bullet_points && Array.isArray(job.bullet_points)) {
        for (const bullet of job.bullet_points) {
          const cleaned = polishBodyNumbers(deepSanitize(bullet));
          if (cleaned && cleaned.length > 3) {
            output += `- ${cleaned}\n`;
          }
        }
      }
      output += '\n';
    }
  }

  // SKILLS
  if (data.skills && Array.isArray(data.skills) && data.skills.length > 0) {
    output += 'SKILLS\n\n';
    for (const skillGroup of data.skills) {
      if (skillGroup.category && skillGroup.items && Array.isArray(skillGroup.items)) {
        const category = deepSanitize(skillGroup.category);
        const items = skillGroup.items.map(item => deepSanitize(item)).filter(Boolean).join(', ');
        if (items) {
          output += `${category}: ${items}\n`;
        }
      }
    }
    output += '\n';
  }

  // EDUCATION
  if (data.education && Array.isArray(data.education) && data.education.length > 0) {
    output += 'EDUCATION\n\n';
    for (const edu of data.education) {
      const degree = deepSanitize(edu.degree || '');
      const school = deepSanitize(edu.school || '');
      const date = deepSanitize(edu.graduation_date || '');
      const details = deepSanitize(edu.details || '');
      
      if (degree) output += `${degree}\n`;
      
      const eduParts = [];
      if (school) eduParts.push(school);
      if (date) eduParts.push(date);
      if (eduParts.length > 0) {
        output += eduParts.join(' | ') + '\n';
      }
      
      if (details) output += `${details}\n`;
      output += '\n';
    }
  }

  // CERTIFICATIONS
  if (data.certifications && Array.isArray(data.certifications) && data.certifications.length > 0) {
    output += 'CERTIFICATIONS\n\n';
    for (const cert of data.certifications) {
      const cleaned = deepSanitize(cert);
      if (cleaned) {
        output += `- ${cleaned}\n`;
      }
    }
  }

  return deepSanitize(output);
}

// ============= PDF GENERATION =============

async function generateResumePDF(resumeText) {
  return new Promise((resolve, reject) => {
    try {
      const cleanedText = deepSanitize(resumeText);
      
      const doc = new PDFDocument({
        size: 'letter',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        bufferPages: true
      });

      let pdfBuffer = Buffer.alloc(0);
      doc.on('data', (chunk) => { pdfBuffer = Buffer.concat([pdfBuffer, chunk]); });
      doc.on('end', () => { resolve(pdfBuffer.toString('base64')); });
      doc.on('error', reject);

      const lines = cleanedText.split('\n');
      let isFirstLine = true;
      let nameRendered = false;

      for (const line of lines) {
        const trimmed = line.trim();
        
        if (!trimmed) {
          doc.moveDown(0.2);
          continue;
        }

        // FIRST LINE = NAME (large, centered)
        if (isFirstLine && /^[A-Z][A-Z\s\.]+$/.test(trimmed) && !trimmed.includes('|')) {
          doc.fontSize(18).font('Helvetica-Bold').fillColor('#000000');
          doc.text(trimmed, { align: 'center' });
          doc.moveDown(0.2);
          isFirstLine = false;
          nameRendered = true;
          continue;
        }
        
        // SECOND LINE = CONTACT INFO (centered, smaller)
        if (nameRendered && trimmed.includes('|') && (trimmed.includes('@') || trimmed.match(/\(\d{3}\)/))) {
          doc.fontSize(10).font('Helvetica').fillColor('#333333');
          doc.text(trimmed, { align: 'center' });
          doc.moveDown(0.5);
          doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#333333');
          doc.moveDown(0.4);
          nameRendered = false;
          isFirstLine = false;
          continue;
        }

        // SECTION HEADERS (all caps, no pipes)
        if (/^[A-Z\s]+$/.test(trimmed) && trimmed.length > 3 && !trimmed.includes('|')) {
          doc.moveDown(0.3);
          doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000');
          doc.text(trimmed);
          doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#666666');
          doc.moveDown(0.3);
          isFirstLine = false;
          continue;
        }

        // JOB TITLE | COMPANY line (bold)
        if (trimmed.includes('|') && !trimmed.startsWith('-') && !trimmed.includes('@')) {
          // Check if this looks like a job title line (typically first pipe line after section)
          if (!trimmed.match(/^\d/) && trimmed.split('|').length === 2) {
            doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000');
            doc.text(trimmed, { width: 512 });
            doc.moveDown(0.1);
            isFirstLine = false;
            continue;
          }
          // Location | Date line (italic)
          doc.fontSize(10).font('Helvetica-Oblique').fillColor('#555555');
          doc.text(trimmed, { width: 512 });
          doc.moveDown(0.2);
          isFirstLine = false;
          continue;
        }

        // BULLET POINTS
        if (trimmed.startsWith('-')) {
          doc.fontSize(10).font('Helvetica').fillColor('#000000');
          doc.text(trimmed, { width: 512, indent: 10 });
          doc.moveDown(0.15);
          isFirstLine = false;
          continue;
        }

        // REGULAR TEXT (summary, etc.)
        doc.fontSize(10).font('Helvetica').fillColor('#000000');
        doc.text(trimmed, { width: 512 });
        doc.moveDown(0.2);
        isFirstLine = false;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============= MAIN ENDPOINT =============

app.post('/api/tailor-resume', upload.single('resume'), async (req, res) => {
  try {
    const { userId, jobDescription } = req.body;
    
    console.log('=== TAILOR RESUME REQUEST ===');
    console.log('userId:', userId);
    
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

    let resumeContent = '';
    if (req.file) {
      resumeContent = await parseResumeFile(req.file.buffer, req.file.mimetype, req.file.originalname);
      if (!resumeContent) {
        return res.status(400).json({ error: 'Unable to parse resume file. Please try a PDF or TXT format.' });
      }
    } else {
      return res.status(400).json({ error: 'Please upload a resume file.' });
    }

    if (resumeContent.trim().length < 50) {
      return res.status(400).json({ error: 'Resume content is too short.' });
    }

    if (!jobDescription || jobDescription.trim().length < 50) {
      return res.status(400).json({ error: 'Job description is required.' });
    }

    const strippedResume = stripResume(resumeContent);
    console.log('Stripped resume length:', strippedResume.length);
    
    const requirements = await extractJobRequirements(jobDescription);
    console.log('Requirements extracted, length:', requirements.length);
    
    const tailoredResume = await tailorResumeWithRequirements(strippedResume, requirements, jobDescription);
    console.log('Tailored resume length:', tailoredResume.length);

    let pdfBase64 = null;
    try {
      pdfBase64 = await generateResumePDF(tailoredResume);
      console.log('PDF generated successfully');
    } catch (pdfErr) {
      console.error('PDF generation error:', pdfErr);
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