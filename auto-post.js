const axios = require('axios');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Function to fetch Google Sheet data using Sheet ID + GID
async function getSheetData(sheetId, gid) {
  try {
    // Build URL with Sheet ID and GID
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    console.log(`📊 Fetching Sheet:`);
    console.log(`   Sheet ID: ${sheetId}`);
    console.log(`   GID: ${gid}`);
    console.log(`   URL: ${url}`);
    
    const response = await axios.get(url);
    const csvData = response.data;
    
    // Parse CSV properly
    const rows = [];
    const lines = csvData.split('\n');
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      // Parse CSV with quote handling
      const fields = [];
      let current = '';
      let inQuotes = false;
      
      for (let char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          fields.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      fields.push(current.trim());
      
      // Clean quotes from fields
      const cleanFields = fields.map(f => f.replace(/^"|"$/g, '').trim());
      
      // Only add if Column A has content
      if (cleanFields[0]) {
        rows.push(cleanFields);
      }
    }
    
    console.log(`📊 Total rows with content: ${rows.length}`);
    
    // Print first 3 rows as preview
    if (rows.length > 0) {
      console.log('📝 Preview of first rows:');
      rows.slice(0, 3).forEach((row, i) => {
        console.log(`   Row ${i + 1}: "${row[0]?.substring(0, 50)}${row[0]?.length > 50 ? '...' : ''}"`);
        if (row[1]) console.log(`          Image: ${row[1]}`);
        if (row[2]) console.log(`          Link: ${row[2]}`);
        if (row[3]) console.log(`          Time: ${row[3]}`);
      });
    }
    
    return rows;
  } catch (error) {
    console.error(`❌ Error fetching sheet (ID: ${sheetId}, GID: ${gid}):`, error.message);
    if (error.response?.status === 404) {
      console.error('   → Sheet not found. Check if Sheet ID and GID are correct.');
      console.error('   → Make sure the sheet is published (File → Share → Publish to web → CSV).');
    }
    return [];
  }
}

// Get current post index for a page
async function getCurrentIndex(pageId) {
  const doc = await db.collection('post_index').doc(pageId).get();
  if (doc.exists) {
    const data = doc.data();
    console.log(`   📍 Current index: ${data.currentIndex || 0} (Row ${(data.currentIndex || 0) + 1})`);
    return data.currentIndex || 0;
  }
  console.log('   📍 Starting from Row 1 (no previous index)');
  return 0;
}

// Update post index
async function updateIndex(pageId, index, totalRows) {
  await db.collection('post_index').doc(pageId).set({
    currentIndex: index,
    totalRows: totalRows,
    sheetId: null, // Will be set from page data
    gid: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log(`   💾 Index updated: ${index} (Next: Row ${index + 1})`);
}

// Parse row data into post object
function parseRowData(row) {
  return {
    message: row[0] || '',
    imageUrl: row[1] || '',
    linkUrl: row[2] || '',
    scheduledTime: row[3] || ''  // Format: HH:MM (UTC)
  };
}

// Check if it's time to post based on scheduled time
function shouldPostNow(scheduledTime) {
  if (!scheduledTime || scheduledTime.trim() === '') {
    return true; // No time specified = post whenever script runs
  }
  
  try {
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return true;
    
    const now = new Date();
    const scheduledTotalMinutes = hours * 60 + minutes;
    const currentTotalMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const diff = Math.abs(currentTotalMinutes - scheduledTotalMinutes);
    
    const shouldPost = diff <= 10; // Within 10 minutes window
    
    if (!shouldPost) {
      console.log(`   ⏰ Scheduled: ${scheduledTime} UTC | Current: ${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')} UTC`);
      console.log(`   ⏭️ Not time yet (${diff} minutes off). Skipping.`);
    }
    
    return shouldPost;
  } catch {
    return true;
  }
}

// Main auto post function
async function autoPost() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 FB AUTO POSTER - GOOGLE SHEETS SEQUENTIAL MODE');
  console.log('🕐 Server Time (UTC):', new Date().toISOString());
  console.log('🕐 Local Time:', new Date().toString());
  console.log('='.repeat(70) + '\n');
  
  try {
    // Get all pages with valid tokens
    const pagesSnapshot = await db.collection('pages')
      .where('tokenValid', '==', true)
      .get();
    
    if (pagesSnapshot.empty) {
      console.log('ℹ️ No active pages with valid tokens found.');
      console.log('   Add pages via the dashboard first.\n');
      return;
    }
    
    console.log(`📄 Found ${pagesSnapshot.size} active page(s)\n`);
    
    let totalPosted = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    
    for (const pageDoc of pagesSnapshot.docs) {
      const page = pageDoc.data();
      const pageDbId = pageDoc.id;
      const pageId = page.pageId;
      const sheetId = page.sheetId;
      const gid = page.gid || '0';
      
      console.log('─'.repeat(70));
      console.log(`📌 PAGE: ${page.name}`);
      console.log(`   Page ID: ${pageId}`);
      console.log(`   Sheet ID: ${sheetId}`);
      console.log(`   GID: ${gid}`);
      console.log(`   Sheet URL: https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`);
      
      try {
        // Fetch data from Google Sheet using Sheet ID + GID
        const rows = await getSheetData(sheetId, gid);
        
        if (rows.length === 0) {
          console.log('   ⚠️ No data found in sheet. Check:');
          console.log('      1. Sheet is published (File → Share → Publish to web → CSV)');
          console.log('      2. Sheet ID and GID are correct');
          console.log('      3. Column A has content');
          totalSkipped++;
          continue;
        }
        
        // Get current position
        const currentIndex = await getCurrentIndex(pageId);
        
        console.log(`   📊 Sheet has ${rows.length} total rows`);
        console.log(`   📍 At Row ${currentIndex + 1} of ${rows.length}`);
        
        // Check if we've gone past all rows
        if (currentIndex >= rows.length) {
          console.log('   🔄 All rows have been posted! Resetting to Row 1.');
          await updateIndex(pageId, 0, rows.length);
          
          // Update page document
          await db.collection('pages').doc(pageDbId).update({
            lastSheetRow: 0,
            totalSheetRows: rows.length,
            sheetId: sheetId,
            gid: gid
          });
          
          totalSkipped++;
          continue;
        }
        
        // Parse current row
        const postData = parseRowData(rows[currentIndex]);
        
        console.log(`   📝 Message: "${postData.message.substring(0, 60)}${postData.message.length > 60 ? '...' : ''}"`);
        if (postData.imageUrl) console.log(`   🖼️ Image URL: ${postData.imageUrl}`);
        if (postData.linkUrl) console.log(`   🔗 Link URL: ${postData.linkUrl}`);
        if (postData.scheduledTime) console.log(`   ⏰ Scheduled Time: ${postData.scheduledTime} UTC`);
        
        // Check if it's time to post
        if (!shouldPostNow(postData.scheduledTime)) {
          totalSkipped++;
          continue;
        }
        
        // Prepare Facebook API request
        let fbUrl, fbParams;
        
        if (postData.imageUrl && postData.imageUrl.startsWith('http')) {
          // Image post
          console.log('   🖼️ Creating IMAGE post...');
          fbUrl = `https://graph.facebook.com/v18.0/${pageId}/photos`;
          fbParams = new URLSearchParams({
            url: postData.imageUrl,
            message: postData.message,
            access_token: page.token
          });
        } else if (postData.linkUrl && postData.linkUrl.startsWith('http')) {
          // Link post
          console.log('   🔗 Creating LINK post...');
          fbUrl = `https://graph.facebook.com/v18.0/${pageId}/feed`;
          fbParams = new URLSearchParams({
            link: postData.linkUrl,
            message: postData.message,
            access_token: page.token
          });
        } else {
          // Text only post
          console.log('   📝 Creating TEXT post...');
          fbUrl = `https://graph.facebook.com/v18.0/${pageId}/feed`;
          fbParams = new URLSearchParams({
            message: postData.message,
            access_token: page.token
          });
        }
        
        // Send to Facebook
        console.log('   📤 Sending to Facebook...');
        const response = await axios.post(fbUrl, fbParams.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        
        if (response.data && response.data.id) {
          console.log(`   ✅ SUCCESS! Facebook Post ID: ${response.data.id}`);
          
          // Move to next row
          const nextIndex = currentIndex + 1;
          await updateIndex(pageId, nextIndex, rows.length);
          
          // Update page document in Firestore
          await db.collection('pages').doc(pageDbId).update({
            lastSheetRow: nextIndex,
            totalSheetRows: rows.length,
            sheetId: sheetId,
            gid: gid,
            lastAutoPost: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Save post log
          await db.collection('post_logs').add({
            pageId: pageId,
            pageName: page.name,
            postId: response.data.id,
            message: postData.message,
            imageUrl: postData.imageUrl || '',
            linkUrl: postData.linkUrl || '',
            sheetRow: currentIndex + 1,
            totalRows: rows.length,
            sheetId: sheetId,
            gid: gid,
            type: 'auto-sheet',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          
          console.log(`   ➡️ Next post will be Row ${nextIndex + 1}`);
          totalPosted++;
          
          // Check if all rows completed
          if (nextIndex >= rows.length) {
            console.log('   🎉 ALL ROWS COMPLETED! Resetting to Row 1 for next cycle.');
            await updateIndex(pageId, 0, rows.length);
          }
        } else {
          throw new Error('No post ID returned from Facebook');
        }
        
      } catch (error) {
        totalFailed++;
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error(`   ❌ FAILED: ${errorMsg}`);
        
        // Check for expired token
        if (error.response?.data?.error?.code === 190) {
          await db.collection('pages').doc(pageDbId).update({
            tokenValid: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log('   ⚠️ Token expired! Marked as invalid.');
          console.log('   🔧 Please update token from dashboard.');
        }
        
        // Check for permission errors
        if (error.response?.status === 403) {
          console.log('   💡 Tip: Make sure the sheet is published (File → Share → Publish to web)');
        }
      }
      
      // Delay between pages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(''); // Empty line between pages
    }
    
    // Final Summary
    console.log('='.repeat(70));
    console.log('📊 FINAL SUMMARY:');
    console.log(`   ✅ Successfully Posted: ${totalPosted}`);
    console.log(`   ❌ Failed: ${totalFailed}`);
    console.log(`   ⏭️ Skipped: ${totalSkipped}`);
    console.log(`   📄 Total Pages Processed: ${pagesSnapshot.size}`);
    console.log('='.repeat(70) + '\n');
    
  } catch (error) {
    console.error('💥 FATAL ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
autoPost()
  .then(() => {
    console.log('✅ Auto post script completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
