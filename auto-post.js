const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ==================== GOOGLE SHEET DATA FETCH ====================
async function getSheetData(sheetId, gid) {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    console.log(`   📊 Fetching: ${url}`);
    
    const response = await axios.get(url);
    const rows = [];
    const lines = response.data.split('\n');
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      // Parse CSV with proper quote handling
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
      
      // Clean quotes
      const cleanFields = fields.map(f => f.replace(/^"|"$/g, '').trim());
      
      // Only include if Column A has content
      if (cleanFields[0]) {
        rows.push(cleanFields);
      }
    }
    
    console.log(`   📊 Found ${rows.length} rows`);
    return rows;
  } catch (error) {
    console.error(`   ❌ Sheet fetch error: ${error.message}`);
    if (error.response?.status === 404) {
      console.error('   💡 Make sure the sheet is published (File → Share → Publish to web → CSV)');
    }
    return [];
  }
}

// ==================== POST INDEX MANAGEMENT ====================
async function getCurrentIndex(pageId) {
  const doc = await db.collection('post_index').doc(pageId).get();
  if (doc.exists) {
    return doc.data().currentIndex || 0;
  }
  return 0;
}

async function updateIndex(pageId, index, totalRows) {
  await db.collection('post_index').doc(pageId).set({
    currentIndex: index,
    totalRows: totalRows,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

// ==================== PARSE ROW DATA ====================
function parseRowData(row) {
  return {
    message: (row[0] || '').trim(),
    imageUrl: (row[1] || '').trim(),
    linkUrl: (row[2] || '').trim()
  };
}

// ==================== TIME CHECK (Using page's postTimes) ====================
function isPostTimeNow(postTimes) {
  // If no times specified, allow posting anytime
  if (!postTimes || postTimes.length === 0) {
    console.log('   ⏰ No times set - posting allowed anytime');
    return true;
  }
  
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const currentTimeStr = `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`;
  
  console.log(`   🕐 Current UTC: ${currentTimeStr}`);
  console.log(`   ⏰ Allowed times: ${postTimes.join(', ')}`);
  
  // Check if current time matches any allowed time (within 30-minute window)
  for (const time of postTimes) {
    const [hours, minutes] = time.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) continue;
    
    const scheduledTotalMinutes = hours * 60 + minutes;
    const currentTotalMinutes = currentHour * 60 + currentMinute;
    const diff = Math.abs(currentTotalMinutes - scheduledTotalMinutes);
    
    if (diff <= 30) {
      console.log(`   ✅ Within window of ${time} UTC (${diff} min off)`);
      return true;
    }
  }
  
  // Find next scheduled time for info
  const nextTimes = postTimes
    .map(t => {
      const [h, m] = t.split(':').map(Number);
      const totalMin = h * 60 + m;
      const currentTotalMin = currentHour * 60 + currentMinute;
      let diff = totalMin - currentTotalMin;
      if (diff < 0) diff += 24 * 60; // Next day
      return { time: t, diff };
    })
    .sort((a, b) => a.diff - b.diff);
  
  if (nextTimes.length > 0) {
    const next = nextTimes[0];
    const hoursUntil = Math.floor(next.diff / 60);
    const minsUntil = next.diff % 60;
    console.log(`   ⏭️ Next post time: ${next.time} UTC (in ${hoursUntil}h ${minsUntil}m)`);
  }
  
  return false;
}

// ==================== POST TO FACEBOOK ====================
async function postToFacebook(page, postData) {
  let url, params;
  
  if (postData.imageUrl && postData.imageUrl.startsWith('http')) {
    // Image post
    console.log('   🖼️ Type: Image Post');
    url = `https://graph.facebook.com/v18.0/${page.pageId}/photos`;
    params = new URLSearchParams({
      url: postData.imageUrl,
      message: postData.message,
      access_token: page.token
    });
  } else if (postData.linkUrl && postData.linkUrl.startsWith('http')) {
    // Link post
    console.log('   🔗 Type: Link Post');
    url = `https://graph.facebook.com/v18.0/${page.pageId}/feed`;
    params = new URLSearchParams({
      link: postData.linkUrl,
      message: postData.message,
      access_token: page.token
    });
  } else {
    // Text only post
    console.log('   📝 Type: Text Post');
    url = `https://graph.facebook.com/v18.0/${page.pageId}/feed`;
    params = new URLSearchParams({
      message: postData.message,
      access_token: page.token
    });
  }
  
  const response = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  
  return response.data;
}

// ==================== MAIN AUTO POST FUNCTION ====================
async function autoPost() {
  const now = new Date();
  
  console.log('\n' + '='.repeat(70));
  console.log('🚀 FB AUTO POSTER - Custom Time Schedule Mode');
  console.log(`🕐 UTC Time: ${now.toISOString()}`);
  console.log(`🕐 Local: ${now.toString()}`);
  console.log(`🕐 Hour: ${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`);
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
    
    console.log(`📄 Processing ${pagesSnapshot.size} active page(s)\n`);
    
    let totalPosted = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    
    for (const pageDoc of pagesSnapshot.docs) {
      const page = pageDoc.data();
      const pageDbId = pageDoc.id;
      const pageId = page.pageId;
      
      console.log('─'.repeat(70));
      console.log(`📌 PAGE: ${page.name}`);
      console.log(`   Page ID: ${pageId}`);
      console.log(`   Sheet ID: ${page.sheetId}`);
      console.log(`   GID: ${page.gid || '0'}`);
      
      // ===== CHECK POSTING TIME =====
      const postTimes = page.postTimes || [];
      console.log(`   ⏰ Configured times: ${postTimes.length > 0 ? postTimes.join(', ') : 'Not set (anytime)'}`);
      
      if (!isPostTimeNow(postTimes)) {
        console.log('   ⏭️ SKIPPED - Not a scheduled posting time\n');
        totalSkipped++;
        continue;
      }
      
      console.log('   ✅ Time check passed! Proceeding to post...');
      
      try {
        // ===== FETCH SHEET DATA =====
        const rows = await getSheetData(page.sheetId, page.gid || '0');
        
        if (rows.length === 0) {
          console.log('   ⚠️ Sheet is empty or not accessible');
          console.log('   💡 Make sure sheet is published: File → Share → Publish to web → CSV\n');
          totalSkipped++;
          continue;
        }
        
        // ===== GET CURRENT INDEX =====
        const currentIndex = await getCurrentIndex(pageId);
        
        console.log(`   📊 Sheet has ${rows.length} total rows`);
        console.log(`   📍 Current position: Row ${currentIndex + 1} of ${rows.length}`);
        
        // ===== CHECK IF ALL ROWS DONE =====
        if (currentIndex >= rows.length) {
          console.log('   🔄 All rows completed! Resetting to Row 1 for next cycle.');
          await updateIndex(pageId, 0, rows.length);
          await db.collection('pages').doc(pageDbId).update({
            lastSheetRow: 0,
            totalSheetRows: rows.length
          });
          totalSkipped++;
          console.log('');
          continue;
        }
        
        // ===== PARSE CURRENT ROW =====
        const postData = parseRowData(rows[currentIndex]);
        
        console.log(`   📝 Message: "${postData.message.substring(0, 60)}${postData.message.length > 60 ? '...' : ''}"`);
        if (postData.imageUrl) console.log(`   🖼️ Image URL: ${postData.imageUrl}`);
        if (postData.linkUrl) console.log(`   🔗 Link URL: ${postData.linkUrl}`);
        
        // ===== POST TO FACEBOOK =====
        console.log('   📤 Sending to Facebook...');
        const result = await postToFacebook(page, postData);
        
        if (result && result.id) {
          console.log(`   ✅ SUCCESS! Facebook Post ID: ${result.id}`);
          
          // Move to next row
          const nextIndex = currentIndex + 1;
          await updateIndex(pageId, nextIndex, rows.length);
          
          // Update page document
          await db.collection('pages').doc(pageDbId).update({
            lastSheetRow: nextIndex,
            totalSheetRows: rows.length,
            lastAutoPost: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Save post log
          await db.collection('post_logs').add({
            pageId: pageId,
            pageName: page.name,
            postId: result.id,
            message: postData.message,
            imageUrl: postData.imageUrl || '',
            linkUrl: postData.linkUrl || '',
            sheetRow: currentIndex + 1,
            totalRows: rows.length,
            sheetId: page.sheetId,
            gid: page.gid || '0',
            postedAt: admin.firestore.FieldValue.serverTimestamp(),
            type: 'auto-scheduled',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          
          console.log(`   ➡️ Next post will be Row ${nextIndex + 1} at next scheduled time`);
          
          // Check if all rows completed
          if (nextIndex >= rows.length) {
            console.log('   🎉 ALL ROWS COMPLETED! Resetting to Row 1.');
            await updateIndex(pageId, 0, rows.length);
          }
          
          totalPosted++;
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
          console.log('   ⚠️ TOKEN EXPIRED! Marked as invalid. Please update from dashboard.');
        }
        
        // Check for permission errors
        if (error.response?.status === 403) {
          console.log('   💡 Tip: Make sure the sheet is published to web (File → Share → Publish to web → CSV)');
        }
      }
      
      // Delay between pages
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(''); // Empty line
    }
    
    // ===== FINAL SUMMARY =====
    console.log('='.repeat(70));
    console.log('📊 FINAL SUMMARY:');
    console.log(`   ✅ Successfully Posted: ${totalPosted}`);
    console.log(`   ⏭️ Skipped (not time yet): ${totalSkipped}`);
    console.log(`   ❌ Failed: ${totalFailed}`);
    console.log(`   📄 Total Pages Processed: ${pagesSnapshot.size}`);
    console.log(`   🕐 Completed at: ${new Date().toISOString()}`);
    console.log('='.repeat(70) + '\n');
    
  } catch (error) {
    console.error('💥 FATAL ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// ==================== RUN ====================
autoPost()
  .then(() => {
    console.log('✅ Auto post script completed successfully!\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });