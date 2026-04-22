const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const config = require('../config/secrets');

let doc = null;

/**
 * Initialize Google Sheets connection
 */
async function initGoogleSheets() {
  if (doc) {
    return doc;
  }

  if (!config.googleSheets.sheetId || !config.googleSheets.clientEmail || !config.googleSheets.privateKey) {
    throw new Error('Google Sheets configuration is missing. Please check your secrets.json file.');
  }

  // Create JWT auth client
  const serviceAccountAuth = new JWT({
    email: config.googleSheets.clientEmail,
    key: config.googleSheets.privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  // Initialize the sheet
  doc = new GoogleSpreadsheet(config.googleSheets.sheetId, serviceAccountAuth);
  await doc.loadInfo();

  return doc;
}

/**
 * Check if email exists in the Google Sheet
 * @param {string} email - Email address to check (should be pre-sanitized)
 * @returns {Promise<boolean>} True if email exists, false otherwise
 */
async function checkEmailInSheet(email) {
  try {
    const sheet = await initGoogleSheets();
    
    // Validate sheet index is a number
    const sheetIndex = typeof config.googleSheets.sheetIndex === 'number' 
      ? config.googleSheets.sheetIndex 
      : 0;
    
    // Validate sheet index is within bounds
    if (sheetIndex < 0 || sheetIndex >= sheet.sheetCount) {
      throw new Error('Invalid sheet index');
    }
    
    const worksheet = sheet.sheetsByIndex[sheetIndex];
    
    // Load all rows
    const rows = await worksheet.getRows();
    
    // Determine which column contains emails
    const emailColumn = config.googleSheets.emailColumn || 0;
    
    // Check if email exists (email should already be lowercased and trimmed)
    const emailLower = email.toLowerCase().trim();
    
    for (const row of rows) {
      let rowEmail;
      
      try {
        if (typeof emailColumn === 'number') {
          // Validate column index is within bounds
          if (emailColumn < 0 || emailColumn >= worksheet.headerValues.length) {
            continue; // Skip invalid column index
          }
          rowEmail = row.get(worksheet.headerValues[emailColumn]);
        } else if (typeof emailColumn === 'string') {
          // Column name - validate it exists
          if (!worksheet.headerValues.includes(emailColumn)) {
            continue; // Skip if column doesn't exist
          }
          rowEmail = row.get(emailColumn);
        } else {
          continue; // Invalid column specification
        }
        
        // Safe comparison (both should be sanitized)
        if (rowEmail && typeof rowEmail === 'string' && rowEmail.toLowerCase().trim() === emailLower) {
          return true;
        }
      } catch (rowError) {
        // Skip rows that cause errors (malformed data)
        continue;
      }
    }
    
    return false;
  } catch (error) {
    // Don't expose internal structure in error messages
    console.error('Error checking email in Google Sheet:', error.message);
    throw error;
  }
}

/**
 * Get user data from Google Sheet by email
 * @param {string} email - Email address
 * @returns {Promise<Object|null>} User data or null if not found
 */
async function getUserData(email) {
  try {
    const sheet = await initGoogleSheets();
    const sheetIndex = config.googleSheets.sheetIndex || 0;
    const worksheet = sheet.sheetsByIndex[sheetIndex];
    const rows = await worksheet.getRows();
    
    const emailColumn = config.googleSheets.emailColumn || 0;
    const emailLower = email.toLowerCase().trim();
    
    for (const row of rows) {
      let rowEmail;
      
      if (typeof emailColumn === 'number') {
        rowEmail = row.get(worksheet.headerValues[emailColumn]);
      } else {
        rowEmail = row.get(emailColumn);
      }
      
      if (rowEmail && rowEmail.toLowerCase().trim() === emailLower) {
        // Return all row data as object
        return row.toObject();
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting user data from Google Sheet:', error);
    throw error;
  }
}

module.exports = {
  checkEmailInSheet,
  getUserData,
  initGoogleSheets
};
