const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Function to get data from Google Sheet (published as CSV)
async function getGoogleSheetData(sheetId, gid) {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    console.log(`📊 Fetching sheet: ${url}`);
    
    const response = await axios.get(url);
    const csvData = response.data;
    
    // Parse CSV
    const rows = csvData.split('\n').map(row => {
      // Handle quoted fields
      const matches = row.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
      return matches.map(field => field.replace(/^"|"$/g, '').trim());
    }).filter(row => row.length > 0 && row[0]); // Remove empty rows
    
    console.log(`📊 Found ${rows.length} rows in sheet`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching sheet:', error.message);
    return [];
  }
}

// Function to get the next post index
async function getNextPostIndex(pageId) {
  const indexDoc = await db.collection('post_index').doc(pageId).get();
  if (indexDoc.exists) {
    return indexDoc.data().currentIndex || 0;
  }
  return 0;
}

// Function to update the post index
async function updatePostIndex(pageId, newIndex) {
  await db.collection('post_index').doc(pageId).set({
    currentIndex: newIndex,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

// Function to parse sheet row for post data
function parsePostData(row, postTime) {
  // Column A: Post content/message
  // Column B: Image URL (optional)
  // Column C: Link URL (optional)
  // Column D: Post time (optional - HH:MM format)
  
  const message = row[0] || '';
  const imageUrl = row[1] || '';
  const linkUrl = row[2] || '';
  const scheduledTime = row[3] || '';
  
  return { message, imageUrl, linkUrl, scheduledTime };
}

// Function to check if it's time to post based on scheduled time
function shouldPostNow(scheduledTime) {
  if (!scheduledTime) return true; // No time specified, post now
  
  try {
    const now = new Date();
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    
    if (isNaN(hours) || isNaN(minutes)) return true;
    
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();
    
    // Allow posting within 5 minutes window
    const scheduledTotalMinutes = hours * 60 + minutes;
    const currentTotalMinutes = currentHour * 60 + currentMinute;
    const diff = Math.abs(currentTotalMinutes - scheduledTotalMinutes);
    
    return diff <= 5; // Within 5 minutes window
  } catch {
    return true; // If parsing fails, post anyway
  }
}

async function autoPost() {
  console.log('='.repeat(60));
  console.log('🚀 FB Auto Poster - Google Sheets Version');
  console.log('🕐 Time:', new Date().toISOString());
  console.log('='.repeat(60));
  
  try {
    // Get all pages with valid tokens
    const pagesSnapshot = await db.collection('pages')
      .where('tokenValid', '==', true)
      .get();
    
    if (pagesSnapshot.empty) {
      console.log('ℹ️ No active pages found. Exiting.');
      return;
    }
    
    console.log(`📄 Processing ${pagesSnapshot.size} active page(s)\n`);
    
    let totalSuccess = 0;
    let totalFail = 0;
    let totalSkipped = 0;
    
    for (const doc of pagesSnapshot.docs) {
      const page = doc.data();
      console.log(`\n📌 Page: ${page.name} (${page.pageId})`);
      console.log(`   Sheet: ${page.sheetName || page.sheetId}`);
      
      try {
        // Get sheet data
        const gid = page.gid || '0'; // Default to first sheet
        const sheetData = await getGoogleSheetData(page.sheetId, gid);
        
        if (sheetData.length === 0) {
          console.log('   ⚠️ Sheet is empty or not accessible');
          totalSkipped++;
          continue;
        }
        
        // Get current index
        const currentIndex = await getNextPostIndex(page.pageId);
        console.log(`   📍 Current index: ${currentIndex} (Row ${currentIndex + 1})`);
        
        // Check if we've reached the end
        if (currentIndex >= sheetData.length) {
          console.log(`   ℹ️ All posts completed (${sheetData.length} total). Resetting to start.`);
          await updatePostIndex(page.pageId, 0);
          continue;
        }
        
        // Get current row data
        const currentRow = sheetData[currentIndex];
        const postData = parsePostData(currentRow);
        
        console.log(`   📝 Message: ${postData.message.substring(0, 50)}${postData.message.length > 50 ? '...' : ''}`);
        
        // Check if it's time to post
        if (!shouldPostNow(postData.scheduledTime)) {
          console.log(`   ⏰ Scheduled for ${postData.scheduledTime || 'anytime'}, skipping for now`);
          totalSkipped++;
          continue;
        }
        
        // Post to Facebook
        let url, params;
        
        if (postData.imageUrl) {
          // Image post
          console.log('   🖼️ Posting with image...');
          url = `https://graph.facebook.com/v18.0/${page.pageId}/photos`;
          params = new URLSearchParams({
            url: postData.imageUrl,
            message: postData.message,
            access_token: page.token
          });
        } else if (postData.linkUrl) {
          // Link post
          console.log('   🔗 Posting with link...');
          url = `https://graph.facebook.com/v18.0/${page.pageId}/feed`;
          params = new URLSearchParams({
            link: postData.linkUrl,
            message: postData.message,
            access_token: page.token
          });
        } else {
          // Text only post
          console.log('   📝 Posting text...');
          url = `https://graph.facebook.com/v18.0/${page.pageId}/feed`;
          params = new URLSearchParams({
            message: postData.message,
            access_token: page.token
          });
        }
        
        const response = await axios.post(url, params.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        
        if (response.data && response.data.id) {
          console.log(`   ✅ Posted successfully! Post ID: ${response.data.id}`);
          
          // Move to next row
          const nextIndex = currentIndex + 1;
          await updatePostIndex(page.pageId, nextIndex);
          console.log(`   📍 Next index: ${nextIndex} (Row ${nextIndex + 1})`);
          
          // Save post log
          await db.collection('post_logs').add({
            pageId: page.pageId,
            pageName: page.name,
            postId: response.data.id,
            message: postData.message,
            sheetRow: currentIndex + 1,
            type: 'auto-sheet',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Update page's last post time
          await db.collection('pages').doc(doc.id).update({
            lastAutoPost: admin.firestore.FieldValue.serverTimestamp(),
            lastSheetRow: currentIndex + 1
          });
          
          totalSuccess++;
          
          // If we reached the end, reset or notify
          if (nextIndex >= sheetData.length) {
            console.log(`   🔄 All ${sheetData.length} posts completed! Resetting to start.`);
            await updatePostIndex(page.pageId, 0);
            
            await db.collection('post_logs').add({
              pageId: page.pageId,
              pageName: page.name,
              message: 'All sheet posts completed. Reset to start.',
              type: 'system',
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        } else {
          throw new Error('No post ID returned');
        }
        
      } catch (error) {
        totalFail++;
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error(`   ❌ Failed: ${errorMsg}`);
        
        // Check for expired token
        if (error.response?.data?.error?.code === 190) {
          await db.collection('pages').doc(doc.id).update({
            tokenValid: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`   ⚠️ Token invalidated`);
        }
      }
      
      // Delay between pages
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 Final Summary:');
    console.log(`  ✅ Successful: ${totalSuccess}`);
    console.log(`  ❌ Failed: ${totalFail}`);
    console.log(`  ⏭️ Skipped: ${totalSkipped}`);
    console.log(`  📄 Pages Processed: ${pagesSnapshot.size}`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('💥 Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the script
autoPost()
  .then(() => {
    console.log('✅ Auto post completed!');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1);
  });