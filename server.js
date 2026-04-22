const express = require('express');
const path = require('path');
const { checkEmailAndSendMagicLink } = require('./services/auth');
const { verifyMagicLink } = require('./services/magicLink');
const { isValidEmail, sanitizeEmail, isValidToken } = require('./utils/validation');
const { createRateLimiter } = require('./middleware/rateLimiter');
const { securityHeaders } = require('./middleware/security');

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
    let { email } = req.body;
    
    // Validate email exists
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Sanitize email to prevent header injection
    email = sanitizeEmail(email);

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const result = await checkEmailAndSendMagicLink(email);
    
    // Always return success to prevent email enumeration
    res.json({ 
      success: true, 
      message: 'If your email is registered, you will receive a magic link shortly.' 
    });
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error requesting magic link:', error.message);
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
      
      // TODO: Set session/cookie and redirect to edit page
      res.json({ 
        success: true, 
        email: sanitizedEmail,
        message: 'Magic link verified successfully' 
      });
    } else {
      res.status(401).json({ error: 'Invalid or expired magic link' });
    }
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error verifying magic link:', error.message);
    res.status(500).json({ error: 'An error occurred verifying the link.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
