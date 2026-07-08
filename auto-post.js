const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function autoPost() {
  console.log('='.repeat(50));
  console.log('🚀 Auto Post Script Started');
  console.log('🕐 Time:', new Date().toISOString());
  console.log('='.repeat(50));
  
  try {
    // Get all pages with valid tokens
    const pagesSnapshot = await db.collection('pages')
      .where('tokenValid', '==', true)
      .get();
    
    if (pagesSnapshot.empty) {
      console.log('ℹ️ No active pages found. Exiting.');
      return;
    }
    
    console.log(`📄 Found ${pagesSnapshot.size} active page(s)\n`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const doc of pagesSnapshot.docs) {
      const page = doc.data();
      console.log(`📌 Processing: ${page.name} (${page.pageId})`);
      
      try {
        // Get custom message from environment or use default
        const message = process.env.CUSTOM_MESSAGE || 
          `🤖 Automated Post\n\n📅 ${new Date().toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}\n\n#AutoPost #Automated`;
        
        // Post to Facebook Page
        const url = `https://graph.facebook.com/v18.0/${page.pageId}/feed`;
        const params = new URLSearchParams({
          message: message,
          access_token: page.token
        });
        
        const response = await axios.post(url, params.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        
        if (response.data && response.data.id) {
          console.log(`  ✅ Success! Post ID: ${response.data.id}`);
          
          // Save post log to Firestore
          await db.collection('post_logs').add({
            pageId: page.pageId,
            pageName: page.name,
            postId: response.data.id,
            message: message,
            type: 'auto',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Update last post time
          await db.collection('pages').doc(doc.id).update({
            lastAutoPost: admin.firestore.FieldValue.serverTimestamp()
          });
          
          successCount++;
        } else {
          throw new Error('No post ID returned');
        }
        
      } catch (error) {
        failCount++;
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error(`  ❌ Failed: ${errorMsg}`);
        
        // If token expired (error code 190), mark as invalid
        if (error.response?.data?.error?.code === 190) {
          await db.collection('pages').doc(doc.id).update({
            tokenValid: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`  ⚠️ Token invalidated for ${page.name}`);
        }
      }
      
      // Small delay between posts to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 Summary:');
    console.log(`  ✅ Successful: ${successCount}`);
    console.log(`  ❌ Failed: ${failCount}`);
    console.log(`  📄 Total Processed: ${pagesSnapshot.size}`);
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('💥 Fatal error:', error.message);
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
    console.error('❌ Auto post script failed:', error);
    process.exit(1);
  });