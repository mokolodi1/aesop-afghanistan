const express = require('express');
const path = require('path');
const { checkIdAndSendMagicLink } = require('./services/auth');
const { verifyMagicLink } = require('./services/magicLink');
const { findNameByEmail } = require('./services/googleSheets');
const { sanitizeEmail, isValidToken, sanitizeIdentifier } = require('./utils/validation');
const { createRateLimiter } = require('./middleware/rateLimiter');
const { securityHeaders } = require('./middleware/security');
const { formatErrorForLog } = require('./utils/errorLogging');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for accurate IP addresses (important for Fly.io)
app.set('trust proxy', 1);

// Security headers
app.use(securityHeaders());

// Middleware
app.use(express.json({ limit: '10kb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AESOP Afghanistan API',
    timestamp: new Date().toISOString()
  });
});

// Rate limiter for magic link requests (5 requests per 15 minutes per IP)
const magicLinkRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// Request magic link
app.post('/api/request-magic-link', magicLinkRateLimiter, async (req, res) => {
  try {
    let { userId } = req.body;
    
    // Validate ID exists
    if (!userId || typeof userId !== 'string') {
      console.warn('Invalid student ID request: missing or non-string ID', {
        ip: req.ip,
        route: req.originalUrl
      });
      return res.status(400).json({ error: 'ID is required' });
    }

    // Sanitize and validate ID format
    userId = sanitizeIdentifier(userId);
    if (!userId) {
      console.warn('Invalid student ID request: failed ID sanitization', {
        ip: req.ip,
        route: req.originalUrl
      });
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const result = await checkIdAndSendMagicLink(userId);
    if (!result?.userFound) {
      // Keep generic response for user enumeration prevention, but log internal signal.
      console.warn('Invalid student ID request: ID not found', {
        ip: req.ip,
        route: req.originalUrl,
        userId
      });
    }
    
    // Always return success to prevent user enumeration
    res.json({ 
      success: true, 
      message: 'If your submitted student ID is valid, a magic link has been sent to your registered email.' 
    });
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error requesting magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred. Please try again later.' });
  }
});

// Rate limiter for token verification (10 attempts per 15 minutes per IP)
const verifyRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

// Verify magic link (changed to POST to prevent token exposure in URLs/logs)
app.post('/api/verify-magic-link', verifyRateLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    
    // Validate token exists
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Validate token format to prevent injection
    if (!isValidToken(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const result = await verifyMagicLink(token);
    
    if (result.valid) {
      // Sanitize email before returning
      const sanitizedEmail = sanitizeEmail(result.email);
      const studentName = await findNameByEmail(sanitizedEmail);
      
      // TODO: Set session/cookie and redirect to edit page
      res.json({ 
        success: true, 
        email: sanitizedEmail,
        name: studentName || '',
        message: 'Magic link verified successfully' 
      });
    } else {
      res.status(401).json({ error: 'Invalid or expired magic link' });
    }
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error verifying magic link:', formatErrorForLog(error));
    res.status(500).json({ error: 'An error occurred verifying the link.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
