const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3001;

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json'); // You'll need to create this file

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const tasksCollection = db.collection('tasks');
const configCollection = db.collection('configurations');
const withdrawalsCollection = db.collection('withdrawals');
const completionLocks = new Map();


// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

// Bot configuration
const botToken = '8488159096:AAHnzzdhE2wrIKCS5OtR2o3K_1Cw3PL38kg';
const adminId = '5650788149';
const bot = new TelegramBot(botToken);

// Channel configuration
const channels = {
  'EchoEarn': '-1002586398527',
  'Tapy': '-1001605359797'
};

// In your index.js - make sure default data uses numbers
function getDefaultAdsTaskData() {
  return {
    lastAdDate: '',
    adsToday: 0,        // Number
    lastAdHour: -1,     // Number  
    adsThisHour: 0,     // Number
    lifetimeAds: 0,     // Number
    totalEarnings: 0,   // Number
    history: []
  };
}

// Firestore Helper functions for user data management
async function loadUsers() {
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = {};
    usersSnapshot.forEach(doc => {
      users[doc.id] = doc.data();
    });
    return users;
  } catch (error) {
    console.error('Error loading user data from Firestore:', error);
    return {};
  }
}

async function saveUser(userId, userData) {
  try {
    await db.collection('users').doc(userId.toString()).set(userData, { merge: true });
    return true;
  } catch (error) {
    console.error('Error saving user to Firestore:', error);
    return false;
  }
}

async function addUser(userId, userData = {}) {
  try {
    const userRef = db.collection('users').doc(userId.toString());
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      // Create new user
      const newUser = {
        id: userId,
        username: userData.username || '',
        first_name: userData.first_name || '',
        last_name: userData.last_name || '',
        verified: true,
        join_date: admin.firestore.FieldValue.serverTimestamp(),
        last_verified: admin.firestore.FieldValue.serverTimestamp(),
        last_activity: admin.firestore.FieldValue.serverTimestamp(),
        balance: 0,
        transactions: [],
        processedEvents: []
      };
      
      await userRef.set(newUser);
      console.log(`✅ New user added to Firestore: ${userId}`);
      return true;
    } else {
      // Update existing user
      const updateData = {
        verified: true,
        last_verified: admin.firestore.FieldValue.serverTimestamp(),
        last_activity: admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Update user info if provided
      if (userData.username) updateData.username = userData.username;
      if (userData.first_name) updateData.first_name = userData.first_name;
      if (userData.last_name) updateData.last_name = userData.last_name;
      
      await userRef.update(updateData);
      return true;
    }
  } catch (error) {
    console.error('Error adding/updating user in Firestore:', error);
    return false;
  }
}

async function getUser(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    return userDoc.exists ? userDoc.data() : null;
  } catch (error) {
    console.error('Error getting user from Firestore:', error);
    return null;
  }
}

async function updateUserVerification(userId, status) {
  try {
    await db.collection('users').doc(userId.toString()).update({
      verified: status,
      last_verified: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('Error updating user verification:', error);
    return false;
  }
}

// Add this to your withdrawal creation endpoint or function
async function sendWithdrawalRequestDM(userId, amount, wkcAmount) {
    try {
        const message = `📥 *Withdrawal Request Received*\n\n` +
                       `💰 *Amount:* ${wkcAmount} WKC (${amount} points)\n` +
                       `⏰ *Requested:* ${new Date().toLocaleString()}\n\n` +
                       `🔄 Your request is in queue and will be processed within 5-15 minutes.\n` +
                       `You will receive another notification when it's completed.`;

        await bot.sendMessage(userId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
        console.log(`✅ Withdrawal request DM sent to user ${userId}`);
    } catch (error) {
        console.error('❌ Failed to send withdrawal request DM:', error);
    }
}

// Fix the updateUserBalance function with better error handling
async function updateUserBalance(userId, amount, transactionData = null) {
  try {
    console.log(`💰 Updating balance for user ${userId}: +${amount} points`);
    
    const userRef = db.collection('users').doc(userId.toString());
    
    // First, get the current user data to see the current balance
    const userDoc = await userRef.get();
    const currentBalance = userDoc.exists ? (userDoc.data().balance || 0) : 0;
    
    console.log(`📊 Current balance: ${currentBalance}, Adding: ${amount}`);
    
    if (transactionData) {
      // Create transaction data
      const transaction = {
        ...transactionData,
        timestamp: new Date().toISOString(),
        balanceBefore: currentBalance,
        balanceAfter: currentBalance + amount
      };
      
      console.log('📝 Transaction data:', transaction);
      
      // Update balance and transactions in separate operations to avoid timestamp issues
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(amount),
        last_activity: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Add transaction to array
      await userRef.update({
        transactions: admin.firestore.FieldValue.arrayUnion(transaction)
      });
      
    } else {
      // Just update balance
      await userRef.update({
        balance: admin.firestore.FieldValue.increment(amount),
        last_activity: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    // Verify the update worked
    const updatedDoc = await userRef.get();
    const newBalance = updatedDoc.data().balance || 0;
    
    console.log(`✅ Balance update successful! New balance: ${newBalance}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error updating user balance:', error);
    console.error('Error details:', error.message);
    return false;
  }
}

// Set webhook route
app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `https://www.echoearn.work/bot${botToken}`;
    const result = await bot.setWebHook(webhookUrl);
    console.log('Webhook set successfully:', result);
    res.json({ success: true, message: 'Webhook set successfully', result });
  } catch (error) {
    console.error('Error setting webhook:', error);
    res.status(500).json({ error: 'Failed to set webhook', details: error.message });
  }
});

// Webhook endpoint
app.post(`/bot${botToken}`, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing update:', error);
    res.sendStatus(200);
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Handle bot commands and messages
bot.on('message', async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text || '';
    
    // Always add/update user when they send any message
    await addUser(userId.toString(), {
      username: msg.from.username,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name
    });

    // Handle /start command with referral parameter
    if (text.startsWith('/start')) {
      const startParam = text.split(' ')[1]; // Get referral parameter
      
      let welcomeMessage = `👋 Welcome to EchoEARN Bot!\n\n`;
      welcomeMessage += `🎯 <b>Earn points by completing simple tasks</b>\n`;
      welcomeMessage += `💰 <b>Withdraw your earnings easily</b>\n\n`;
      
      // ✅ PROCESS REFERRAL IMMEDIATELY
      if (startParam) {
        console.log(`🔗 Start parameter detected: ${startParam}`);
        
        let referrerId = null;
        
        // Parse referral parameter
        if (startParam.startsWith('ref')) {
          referrerId = startParam.replace('ref', '');
        } else if (startParam.match(/^\d+$/)) {
          referrerId = startParam;
        }
        
        if (referrerId && referrerId !== userId.toString()) {
          console.log(`🎯 Processing referral: ${referrerId} -> ${userId}`);
          
          // Check if referral already processed
          const userRef = db.collection('users').doc(userId.toString());
          const userDoc = await userRef.get();
          
          let alreadyProcessed = false;
          if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData.referredBy) {
              alreadyProcessed = true;
              console.log('❌ Referral already processed for this user');
            }
          }
          
          if (!alreadyProcessed) {
            // Process referral bonus
            const referralSuccess = await processReferralInBot(referrerId, userId.toString());
            
            if (referralSuccess) {
              welcomeMessage += `🎉 <b>You joined via referral! Your friend earned bonus points.</b>\n\n`;
              
              // Mark user as referred
              await userRef.set({
                referredBy: referrerId,
                referralProcessed: true,
                joinedVia: 'referral'
              }, { merge: true });
            }
          }
        }
      }
      
      welcomeMessage += `📱 <b>Click the button below to start earning!</b>`;
      
      const keyboard = {
        inline_keyboard: [[
          {
            text: '🚀 Start Earning',
            web_app: { url: 'https://www.echoearn.work/' }
          }
        ]]
      };
      
      await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    }

    // Handle web app data (existing code)
    if (msg.web_app_data) {
      try {
        const data = JSON.parse(msg.web_app_data.data);
        
        if (data.action === 'channels_joined' && data.userId) {
          const userInfo = `User ${data.userId} has joined all channels`;
          console.log(userInfo);
          
          await bot.sendMessage(adminId, userInfo);
          await bot.sendMessage(chatId, 'Thank you for joining our channels! 🎉');
        }
      } catch (error) {
        console.error('Error processing web app data:', error);
      }
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

// ✅ NEW FUNCTION: Process referral directly in bot
async function processReferralInBot(referrerId, referredUserId) {
  try {
    console.log(`💰 Processing referral in bot: ${referrerId} referred ${referredUserId}`);
    
    // Get referral configuration
    const configDoc = await configCollection.doc('points').get();
    const pointsConfig = configDoc.exists ? configDoc.data() : {};
    const referralBonus = parseInt(pointsConfig.friendInvitePoints) || 20;
    
    // Update referrer's balance and referral count
    const referrerRef = db.collection('users').doc(referrerId.toString());
    const referrerDoc = await referrerRef.get();
    
    if (!referrerDoc.exists) {
      console.log('❌ Referrer not found in database');
      return false;
    }
    
    // Add referral bonus
    await updateUserBalance(referrerId, referralBonus, {
      type: 'referral_bonus',
      amount: referralBonus,
      description: `Referral bonus for inviting user ${referredUserId}`,
      referredUserId: referredUserId,
      timestamp: new Date().toISOString()
    });
    
    // Update referral count
    const currentReferrals = referrerDoc.data().referral_count || 0;
    await referrerRef.update({
      referral_count: currentReferrals + 1,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Add to referral history
    const referralEntry = {
      referredUserId: referredUserId,
      bonusAmount: referralBonus,
      timestamp: new Date().toISOString()
    };
    
    await referrerRef.update({
      referral_history: admin.firestore.FieldValue.arrayUnion(referralEntry)
    });
    
    console.log(`✅ Referral processed in bot: ${referrerId} earned ${referralBonus} points`);
    
    // Send DM notification to referrer
    try {
      await bot.sendMessage(
        referrerId, 
        `🎉 *Referral Bonus!*\n\n👤 Your friend joined using your referral link!\n💰 *Bonus Earned:* ${referralBonus} points\n\nKeep inviting to earn more! 🚀`,
        { parse_mode: 'Markdown' }
      );
      console.log(`✅ Referral DM sent to ${referrerId}`);
    } catch (dmError) {
      console.error('Failed to send referral DM:', dmError);
    }
    
    return true;
    
  } catch (error) {
    console.error('Error processing referral in bot:', error);
    return false;
  }
}

// API endpoint to check if user is member of channels
app.get('/api/telegram/check-membership', async (req, res) => {
  const { userId, channelIds } = req.query;
  
  if (!userId || !channelIds) {
    return res.status(400).json({ error: 'Missing userId or channelIds parameters' });
  }
  
  try {
    // Parse the channelIds from JSON string
    const channelsArray = JSON.parse(channelIds);
    
    const membershipStatus = {};
    const numericUserId = parseInt(userId);

    // Add user when they check membership
    await addUser(userId.toString());

    for (const channelId of channelsArray) {
      try {
        const cleanChannelId = channelId.trim();
        const result = await bot.getChatMember(cleanChannelId, numericUserId);
        const status = result.status;
        membershipStatus[cleanChannelId] = !['left', 'kicked'].includes(status);
        console.log(`✅ User ${numericUserId} status in ${cleanChannelId}: ${status}`);
      } catch (error) {
        console.error(`❌ Error checking membership for ${channelId}:`, error.message);
        membershipStatus[channelId] = false;
      }
    }

    // If all channels are joined, mark user as verified
    const allJoined = Object.values(membershipStatus).every(status => status === true);
    if (allJoined) {
      await addUser(userId.toString());
      
      // Notify admin
      try {
        await bot.sendMessage(adminId, `✅ User ${numericUserId} has successfully joined all channels!`);
      } catch (adminError) {
        console.error('Failed to notify admin:', adminError);
      }
    } else {
      // Update verification status if user left some channels
      await updateUserVerification(numericUserId.toString(), false);
    }

    res.json({ 
      success: true, 
      userId: numericUserId,
      membership: membershipStatus,
      allJoined: allJoined
    });
  } catch (error) {
    console.error('Overall error checking membership:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// API endpoint to verify user status from home page
app.get('/api/telegram/verify-user', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' });
  }
  
  try {
    const numericUserId = parseInt(userId);
    const user = await getUser(numericUserId.toString());
    
    if (user && user.verified) {
      res.json({ 
        success: true, 
        verified: true,
        joinDate: user.join_date 
      });
    } else {
      res.json({ 
        success: true, 
        verified: false 
      });
    }
  } catch (error) {
    console.error('Error verifying user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to notify about joined channels
app.post('/api/telegram/notify-joined', async (req, res) => {
  const { userId, action } = req.body;
  
  if (action === 'channels_joined' && userId) {
    const userInfo = `User ${userId} has joined all channels`;
    console.log(userInfo);
    
    try {
      await bot.sendMessage(adminId, userInfo);
      res.json({ success: true });
    } catch (error) {
      console.error('Error sending notification:', error);
      res.status(500).json({ error: 'Failed to send notification' });
    }
  } else {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// Postback endpoint for Monetag ads
app.get('/api', async (req, res) => {
    try {
        const {
            telegram_id,
            zone_id,
            reward_event_type,
            event_type,
            sub_zone_id,
            ymid,
            request_var,
            estimated_price
        } = req.query;

        console.log('💰 Postback received from Monetag:', {
            telegram_id,
            zone_id,
            reward_event_type,
            event_type,
            sub_zone_id,
            ymid,
            request_var,
            estimated_price,
            timestamp: new Date().toISOString()
        });

        // Validate required parameters
        if (!telegram_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing telegram_id parameter' 
            });
        }

        // Only process 'click' events (as per requirement)
        if (event_type !== 'click') {
            console.log('ℹ️ Ignoring non-click event:', event_type);
            return res.status(200).json({ 
                success: true, 
                message: 'Ignoring non-click event' 
            });
        }

        // Only process paid events
        if (reward_event_type !== 'valued') {
            console.log('ℹ️ Ignoring unpaid event:', reward_event_type);
            return res.status(200).json({ 
                success: true, 
                message: 'Ignoring unpaid event' 
            });
        }

        // Get user data from Firestore
        const numericTelegramId = telegram_id.toString();
        let user = await getUser(numericTelegramId);
        
        // Add user if they don't exist
        if (!user) {
            await addUser(numericTelegramId);
            user = await getUser(numericTelegramId);
        }

        if (!user) {
            console.log('❌ User not found:', telegram_id);
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }

        // Check if this ymid has already been processed (prevent duplication)
        if (user.processedEvents && user.processedEvents.includes(ymid)) {
            console.log('⚠️ Event already processed:', ymid);
            return res.status(200).json({ 
                success: true, 
                message: 'Event already processed' 
            });
        }

        // Get reward points from settings
        const rewardPoints = 30; // Default reward points

        // Create transaction data
        const transaction = {
            type: 'ad_reward',
            amount: rewardPoints,
            description: `Ad reward from ${request_var || 'unknown_location'}`,
            estimatedPrice: estimated_price ? parseFloat(estimated_price) : 0,
            zoneId: zone_id,
            subZoneId: sub_zone_id,
            eventId: ymid
        };

        // Update user balance and add transaction in Firestore
        const oldBalance = user.balance || 0;
        
        // Add processed event and update user data
        const updatedUserData = {
            processedEvents: admin.firestore.FieldValue.arrayUnion(ymid),
            last_activity: admin.firestore.FieldValue.serverTimestamp()
        };

        // Keep only last 100 events to prevent array from growing too large
        if (user.processedEvents && user.processedEvents.length >= 100) {
            // This would require a more complex operation in Firestore
            // For now, we'll just add the new event and handle trimming separately
            console.log('⚠️ Processed events array growing large, consider cleanup');
        }

        await saveUser(numericTelegramId, updatedUserData);
        await updateUserBalance(numericTelegramId, rewardPoints, transaction);

        console.log(`✅ Reward added: ${rewardPoints} points to user ${telegram_id}. Balance: ${oldBalance} → ${oldBalance + rewardPoints}`);

        // Send successful response to Monetag
        res.status(200).json({ 
            success: true, 
            message: 'Reward processed successfully',
            pointsAdded: rewardPoints,
            newBalance: oldBalance + rewardPoints,
            userTelegramId: telegram_id
        });

    } catch (error) {
        console.error('❌ Postback error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error',
            error: error.message 
        });
    }
});

// API endpoint to verify membership for tasks
app.get('/api/tasks/verify-membership', async (req, res) => {
    const { userId, channelId } = req.query;
    
    if (!userId || !channelId) {
        return res.status(400).json({ error: 'Missing userId or channelId parameters' });
    }
    
    try {
        const numericUserId = parseInt(userId);
        const result = await bot.getChatMember(channelId, numericUserId);
        const status = result.status;
        const isMember = !['left', 'kicked'].includes(status);
        
        res.json({ 
            success: true, 
            userId: numericUserId,
            channelId: channelId,
            isMember: isMember,
            status: status
        });
    } catch (error) {
        console.error(`Error checking membership for ${channelId}:`, error.message);
        res.status(500).json({ 
            error: 'Failed to check membership', 
            details: error.message 
        });
    }
});

// Notification system for new tasks
async function sendTaskNotificationToAllUsers(taskData) {
    try {
        const usersSnapshot = await db.collection('users').get();
        const userCount = usersSnapshot.size;
        let sentCount = 0;
        let failedCount = 0;

        console.log(`📢 Sending task notification to ${userCount} users...`);

        // Determine task type and emoji
        let taskType, emoji;
        switch (taskData.type) {
            case 'channel':
                taskType = 'TG';
                emoji = '📢';
                break;
            case 'group':
                taskType = 'TG';
                emoji = '👥';
                break;
            case 'facebook':
                taskType = 'FB';
                emoji = '📘';
                break;
            case 'tiktok':
                taskType = 'TT';
                emoji = '🎵';
                break;
            case 'website':
                taskType = 'WEB';
                emoji = '🌐';
                break;
            default:
                taskType = 'TG';
                emoji = '📋';
        }

        const message = `${emoji} <b>🆕 New ${taskType} task: ${taskData.title} (+${taskData.amount} pts). Check Tasks now!</b>`;

        // Send to each user
        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            try {
                await bot.sendMessage(userId, message, { parse_mode: 'HTML' });
                sentCount++;
                console.log(`✅ Notification sent to user ${userId}`);
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`❌ Failed to send notification to user ${userId}:`, error.message);
                failedCount++;
                
                // If user blocked the bot or chat doesn't exist, you might want to mark them as inactive
                if (error.response && error.response.statusCode === 403) {
                    console.log(`🗑️ User ${userId} blocked the bot, consider marking as inactive`);
                    // You could add an 'active' field to users and set it to false here
                }
            }
        }

        console.log(`📊 Notification summary: ${sentCount} sent, ${failedCount} failed`);

        // Notify admin about the broadcast
        await bot.sendMessage(
            adminId, 
            `📢 Task notification sent!\n\n` +
            `📝 Task: ${taskData.title}\n` +
            `💰 Amount: ${taskData.amount} pts\n` +
            `📊 Results: ${sentCount} sent, ${failedCount} failed\n` +
            `👥 Total users: ${userCount}`
        );

        return { success: true, sent: sentCount, failed: failedCount, total: userCount };
    } catch (error) {
        console.error('❌ Error sending task notifications:', error);
        return { success: false, error: error.message };
    }
}

// API endpoint to send task notifications
app.post('/api/tasks/send-notification', async (req, res) => {
    try {
        const { taskId, title, amount, type } = req.body;

        if (!title || !amount || !type) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required task data' 
            });
        }

        const taskData = {
            id: taskId || Date.now().toString(),
            title: title,
            amount: parseInt(amount),
            type: type,
            timestamp: new Date().toISOString()
        };

        const result = await sendTaskNotificationToAllUsers(taskData);

        if (result.success) {
            res.json({
                success: true,
                message: `Notification sent to ${result.sent} users`,
                data: result
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to send notifications',
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Error in notification API:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// API endpoint to get user count
app.get('/api/users/count', async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').get();
        const userCount = usersSnapshot.size;
        
        res.json({
            success: true,
            userCount: userCount,
            activeUsers: userCount
        });
    } catch (error) {
        console.error('Error getting user count:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get user count'
        });
    }
});

// API endpoint to get user balance
app.get('/api/user/balance', async (req, res) => {
    const { userId } = req.query;
    
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    try {
        const user = await getUser(userId.toString());
        
        if (user) {
            res.json({ 
                success: true, 
                balance: user.balance || 0,
                userId: userId
            });
        } else {
            res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
    } catch (error) {
        console.error('Error getting user balance:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/withdrawals/check-pending', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const snapshot = await withdrawalsCollection
      .where('userId', '==', userId.toString())
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    
    const hasPending = !snapshot.empty;
    
    res.json({
      success: true,
      hasPending: hasPending,
      userId: userId
    });
  } catch (error) {
    console.error('Error checking pending withdrawals:', error);
    res.status(500).json({ success: false, error: 'Failed to check pending withdrawals' });
  }
});

// Add this API endpoint to your index.js
app.post('/api/user/add-balance', async (req, res) => {
  try {
    const { userId, amount, description, type = 'ad_reward' } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing userId or amount' 
      });
    }
    
    console.log(`💰 Adding balance via API: User ${userId}, Amount: ${amount}, Type: ${type}`);
    
    // Create transaction data
    const transactionData = {
      type: type,
      amount: parseInt(amount),
      description: description || `Ad reward completion`,
      timestamp: new Date().toISOString()
    };
    
    // Use your existing updateUserBalance function
    const success = await updateUserBalance(userId, parseInt(amount), transactionData);
    
    if (success) {
      // Get updated balance to return
      const user = await getUser(userId.toString());
      const newBalance = user ? user.balance : 0;
      
      res.json({
        success: true,
        message: 'Balance updated successfully',
        newBalance: newBalance,
        pointsAdded: amount
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to update balance'
      });
    }
  } catch (error) {
    console.error('Error adding balance:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// Add these endpoints to your index.js file:

// API endpoint to get wallet data
app.get('/api/user/wallet-data', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.json({ 
        success: true, 
        walletData: null 
      });
    }
    
    const user = userDoc.data();
    
    res.json({
      success: true,
      walletData: user.walletData || null
    });
  } catch (error) {
    console.error('Error getting wallet data:', error);
    res.status(500).json({ success: false, error: 'Failed to get wallet data' });
  }
});

// API endpoint to save wallet data
app.post('/api/user/save-wallet-data', async (req, res) => {
  try {
    const { userId, walletData } = req.body;
    
    if (!userId || !walletData) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    await db.collection('users').doc(userId.toString()).update({
      walletData: walletData,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'Wallet data saved successfully' });
  } catch (error) {
    console.error('Error saving wallet data:', error);
    res.status(500).json({ success: false, error: 'Failed to save wallet data' });
  }
});

// API endpoint to deduct balance
app.post('/api/user/deduct-balance', async (req, res) => {
  try {
    const { userId, amount, description } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing userId or amount' 
      });
    }
    
    console.log(`💰 Deducting balance via API: User ${userId}, Amount: ${amount}`);
    
    // Create transaction data
    const transactionData = {
      type: 'wallet_edit_fee',
      amount: -parseInt(amount), // Negative amount for deduction
      description: description || 'Wallet edit fee',
      timestamp: new Date().toISOString()
    };
    
    // Use your existing updateUserBalance function
    const success = await updateUserBalance(userId, -parseInt(amount), transactionData);
    
    if (success) {
      // Get updated balance to return
      const user = await getUser(userId.toString());
      const newBalance = user ? user.balance : 0;
      
      res.json({
        success: true,
        message: 'Balance deducted successfully',
        newBalance: newBalance,
        pointsDeducted: amount
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to deduct balance'
      });
    }
  } catch (error) {
    console.error('Error deducting balance:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// Add these endpoints to your index.js file:

// API endpoint to get user's pending withdrawals total
app.get('/api/withdrawals/user-pending', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const snapshot = await withdrawalsCollection
      .where('userId', '==', userId.toString())
      .where('status', '==', 'pending')
      .get();
    
    let totalPending = 0;
    snapshot.forEach(doc => {
      const withdrawal = doc.data();
      totalPending += withdrawal.amount || 0;
    });
    
    res.json({
      success: true,
      totalPending: totalPending,
      userId: userId
    });
  } catch (error) {
    console.error('Error getting user pending withdrawals:', error);
    res.status(500).json({ success: false, error: 'Failed to get pending withdrawals' });
  }
});

// API endpoint to create withdrawal request
// API endpoint to create withdrawal request
app.post('/api/withdrawals/create', async (req, res) => {
  try {
    const withdrawalRequest = req.body;
    
    if (!withdrawalRequest.userId || !withdrawalRequest.amount || !withdrawalRequest.wallet) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    // Save to Firestore
    await withdrawalsCollection.doc(withdrawalRequest.id).set(withdrawalRequest);
    
    // ✅ FIX: Use withdrawalRequest instead of request
    await sendWithdrawalRequestDM(withdrawalRequest.userId, withdrawalRequest.amount, withdrawalRequest.wkcAmount);
    
    res.json({ 
      success: true, 
      message: 'Withdrawal request created successfully',
      requestId: withdrawalRequest.id
    });
  } catch (error) {
    console.error('Error creating withdrawal request:', error);
    res.status(500).json({ success: false, error: 'Failed to create withdrawal request' });
  }
});

// API endpoint to add withdrawal history to user
app.post('/api/user/add-withdrawal-history', async (req, res) => {
  try {
    const { userId, withdrawalEntry } = req.body;
    
    if (!userId || !withdrawalEntry) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const userRef = db.collection('users').doc(userId.toString());
    
    // Add to withdrawal history array
    await userRef.update({
      withdrawalHistory: admin.firestore.FieldValue.arrayUnion(withdrawalEntry),
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'Withdrawal history added successfully' });
  } catch (error) {
    console.error('Error adding withdrawal history:', error);
    res.status(500).json({ success: false, error: 'Failed to add withdrawal history' });
  }
});

// API endpoint to get user withdrawal history
app.get('/api/user/withdrawal-history', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.json({ 
        success: true, 
        withdrawalHistory: [] 
      });
    }
    
    const user = userDoc.data();
    
    res.json({
      success: true,
      withdrawalHistory: user.withdrawalHistory || []
    });
  } catch (error) {
    console.error('Error getting withdrawal history:', error);
    res.status(500).json({ success: false, error: 'Failed to get withdrawal history' });
  }
});

// API endpoint to get daily rewards data
app.get('/api/user/daily-rewards-data', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.json({ 
        success: true, 
        dailyRewardsData: {
          lastClaimDate: '',
          claimsToday: 0,
          totalClaims: 0,
          history: []
        }
      });
    }
    
    const user = userDoc.data();
    
    res.json({
      success: true,
      dailyRewardsData: user.dailyRewardsData || {
        lastClaimDate: '',
        claimsToday: 0,
        totalClaims: 0,
        history: []
      }
    });
  } catch (error) {
    console.error('Error getting daily rewards data:', error);
    res.status(500).json({ success: false, error: 'Failed to get daily rewards data' });
  }
});

// API endpoint to save daily rewards data
app.post('/api/user/save-daily-rewards-data', async (req, res) => {
  try {
    const { userId, dailyRewardsData } = req.body;
    
    if (!userId || !dailyRewardsData) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    console.log('💾 Saving daily rewards data for user:', userId);
    console.log('📊 Data to save:', dailyRewardsData);
    
    // Save to user document
    await db.collection('users').doc(userId.toString()).update({
      dailyRewardsData: dailyRewardsData,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log('✅ Daily rewards data saved successfully');
    
    res.json({ 
      success: true, 
      message: 'Daily rewards data saved successfully' 
    });
  } catch (error) {
    console.error('❌ Error saving daily rewards data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to save daily rewards data: ' + error.message 
    });
  }
});

// Leaderboard API endpoints
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { userId } = req.query;
    
    // Get top 10 users by balance
    const usersSnapshot = await db.collection('users')
      .orderBy('balance', 'desc')
      .limit(10)
      .get();
    
    const leaderboard = [];
    usersSnapshot.forEach(doc => {
      const user = doc.data();
      leaderboard.push({
        id: doc.id,
        username: user.username || user.first_name,
        balance: user.balance || 0,
        referral_count: user.referral_count || 0
      });
    });
    
    // Get user's rank
    let userRank = '?';
    if (userId) {
      const userDoc = await db.collection('users').doc(userId.toString()).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        const userBalance = userData.balance || 0;
        
        // Count users with higher balance to determine rank
        const higherUsersSnapshot = await db.collection('users')
          .where('balance', '>', userBalance)
          .get();
        
        userRank = higherUsersSnapshot.size + 1;
      }
    }
    
    res.json({
      success: true,
      leaderboard: leaderboard,
      userRank: userRank
    });
    
  } catch (error) {
    console.error('Error loading leaderboard:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load leaderboard' 
    });
  }
});

app.get('/api/leaderboard/rank', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing userId parameter' 
      });
    }
    
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.json({ 
        success: true, 
        rank: '?' 
      });
    }
    
    const userData = userDoc.data();
    const userBalance = userData.balance || 0;
    
    // Count users with higher balance to determine rank
    const higherUsersSnapshot = await db.collection('users')
      .where('balance', '>', userBalance)
      .get();
    
    const rank = higherUsersSnapshot.size + 1;
    
    res.json({
      success: true,
      rank: rank
    });
    
  } catch (error) {
    console.error('Error getting user rank:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get user rank' 
    });
  }
});

// API endpoint to get user ads data
app.get('/api/user/ads-task-data', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.json({ 
        success: true, 
        adsTaskData: getDefaultAdsTaskData()
      });
    }
    
    const user = userDoc.data();
    
    // ✅ FIX: Get data from root level OR from adsData subfield for backward compatibility
    const adsTaskData = user.adsTaskData || user.adsData || getDefaultAdsTaskData();
    
    res.json({
      success: true,
      adsTaskData: adsTaskData
    });
  } catch (error) {
    console.error('Error getting ads task data:', error);
    res.status(500).json({ success: false, error: 'Failed to get ads task data' });
  }
});

app.get('/api/user/ads-data', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.json({ 
        success: true, 
        adsData: {
          lastAdDate: '',
          adsToday: 0,
          lastAdHour: -1,
          adsThisHour: 0,
          lifetimeAds: 0,
          totalEarnings: 0,
          history: []
        }
      });
    }
    
    const user = userDoc.data();
    
    res.json({
      success: true,
      adsData: user.adsData || {
        lastAdDate: '',
        adsToday: 0,
        lastAdHour: -1,
        adsThisHour: 0,
        lifetimeAds: 0,
        totalEarnings: 0,
        history: []
      }
    });
  } catch (error) {
    console.error('Error getting ads data:', error);
    res.status(500).json({ success: false, error: 'Failed to get ads data' });
  }
});

app.post('/api/user/save-ads-task-data', async (req, res) => {
  try {
    const { userId, adsTaskData } = req.body;
    
    if (!userId || !adsTaskData) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    // ✅ FIX: Save to root level as adsTaskData
    await db.collection('users').doc(userId.toString()).update({
      adsTaskData: adsTaskData,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'Ads task data saved successfully' });
  } catch (error) {
    console.error('Error saving ads task data:', error);
    res.status(500).json({ success: false, error: 'Failed to save ads task data' });
  }
});

// API endpoint to save user ads data
app.post('/api/user/save-ads-data', async (req, res) => {
  try {
    const { userId, adsData } = req.body;
    
    if (!userId || !adsData) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    await db.collection('users').doc(userId.toString()).update({
      adsData: adsData,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'Ads data saved successfully' });
  } catch (error) {
    console.error('Error saving ads data:', error);
    res.status(500).json({ success: false, error: 'Failed to save ads data' });
  }
});

// Add this endpoint to your index.js to check user transactions
app.get('/api/user/transactions', async (req, res) => {
    try {
        const { userId } = req.query;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'Missing userId parameter' });
        }
        
        const userDoc = await db.collection('users').doc(userId.toString()).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const user = userDoc.data();
        
        res.json({
            success: true,
            userId: userId,
            balance: user.balance || 0,
            transactions: user.transactions || [],
            completedTasks: user.completedTasks || {},
            last_activity: user.last_activity
        });
    } catch (error) {
        console.error('Error getting user transactions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to save task
app.post('/api/tasks/save', async (req, res) => {
    try {
        const task = req.body;
        await tasksCollection.doc(task.id).set(task);
        res.json({ success: true, message: 'Task saved successfully' });
    } catch (error) {
        console.error('Error saving task:', error);
        res.status(500).json({ success: false, error: 'Failed to save task' });
    }
});

// Add to your index.js backend file

// API endpoint to get task link
app.get('/api/tasks/get-link', async (req, res) => {
    try {
        const { taskId } = req.query;
        
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'Missing taskId parameter' });
        }
        
        const taskDoc = await tasksCollection.doc(taskId).get();
        if (!taskDoc.exists) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        const task = taskDoc.data();
        
        // Redirect to the task link
        res.redirect(task.link);
    } catch (error) {
        console.error('Error getting task link:', error);
        res.status(500).json({ success: false, error: 'Failed to get task link' });
    }
});

// Update the task completion check endpoint
app.get('/api/tasks/is-completed', async (req, res) => {
    try {
        const { userId, taskId } = req.query;
        
        if (!userId || !taskId) {
            return res.status(400).json({ success: false, error: 'Missing userId or taskId parameter' });
        }
        
        const userDoc = await db.collection('users').doc(userId.toString()).get();
        if (!userDoc.exists) {
            return res.json({ success: true, completed: false });
        }
        
        const user = userDoc.data();
        const completedTasks = user.completedTasks || {};
        
        // Check if task is marked as completed in user's document
        const isCompleted = !!completedTasks[taskId];
        
        // Also check if user is in the task's completedBy array (backward compatibility)
        if (!isCompleted) {
            const taskDoc = await tasksCollection.doc(taskId).get();
            if (taskDoc.exists) {
                const task = taskDoc.data();
                const completedBy = task.completedBy || [];
                if (completedBy.includes(userId.toString())) {
                    // If user is in completedBy but not in completedTasks, update it
                    await db.collection('users').doc(userId.toString()).update({
                        [`completedTasks.${taskId}`]: true
                    });
                    return res.json({ success: true, completed: true });
                }
            }
        }
        
        res.json({ 
            success: true, 
            completed: isCompleted 
        });
    } catch (error) {
        console.error('Error checking task completion:', error);
        res.status(500).json({ success: false, error: 'Failed to check task completion' });
    }
});

// Add this endpoint to migrate existing completed tasks to the new system
app.post('/api/tasks/migrate-completed', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'Missing userId' });
        }
        
        // Get all tasks
        const tasksSnapshot = await tasksCollection.get();
        const userRef = db.collection('users').doc(userId.toString());
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        let migratedCount = 0;
        const completedTasks = {};
        
        // Check each task to see if user has completed it
        for (const taskDoc of tasksSnapshot.docs) {
            const task = taskDoc.data();
            const taskId = taskDoc.id;
            const completedBy = task.completedBy || [];
            
            if (completedBy.includes(userId.toString())) {
                completedTasks[taskId] = true;
                migratedCount++;
            }
        }
        
        // Update user's completedTasks
        await userRef.update({
            completedTasks: completedTasks
        });
        
        res.json({ 
            success: true, 
            message: `Migrated ${migratedCount} completed tasks for user ${userId}`,
            migratedCount: migratedCount
        });
        
    } catch (error) {
        console.error('Error migrating completed tasks:', error);
        res.status(500).json({ success: false, error: 'Failed to migrate completed tasks' });
    }
});

// API endpoint to check if task is pending
app.get('/api/tasks/is-pending', async (req, res) => {
    try {
        const { userId, taskId } = req.query;
        
        if (!userId || !taskId) {
            return res.status(400).json({ success: false, error: 'Missing userId or taskId parameter' });
        }
        
        const taskDoc = await tasksCollection.doc(taskId).get();
        if (!taskDoc.exists) {
            return res.json({ success: true, pending: false });
        }
        
        const task = taskDoc.data();
        const pendingApprovals = task.pendingApprovals || [];
        
        const isPending = pendingApprovals.some(approval => approval.userId === userId);
        
        res.json({ 
            success: true, 
            pending: isPending 
        });
    } catch (error) {
        console.error('Error checking task pending status:', error);
        res.status(500).json({ success: false, error: 'Failed to check task pending status' });
    }
});

// Fix the task completion endpoint with locking
app.post('/api/tasks/complete', async (req, res) => {
    const { taskId, userId, amount, taskType } = req.body;
    
    // Create a unique lock key for this user+task combination
    const lockKey = `${userId}_${taskId}`;
    
    // Check if this request is already being processed
    if (completionLocks.has(lockKey)) {
        console.log('⏳ Request already in progress, skipping duplicate:', lockKey);
        return res.status(429).json({ 
            success: false, 
            error: 'Request already being processed' 
        });
    }
    
    // Acquire lock
    completionLocks.set(lockKey, true);
    
    try {
        console.log('🔄 Processing task completion:', { taskId, userId, amount, taskType });
        
        if (!taskId || !userId || !amount) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        // Get task
        const taskDoc = await tasksCollection.doc(taskId).get();
        if (!taskDoc.exists) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        const task = taskDoc.data();
        console.log('📋 Task details:', task.title, 'Completions:', task.completions, 'Limit:', task.taskLimit);
        
        // ✅ CRITICAL: Check if user already completed this task FIRST using transaction
        const userRef = db.collection('users').doc(userId.toString());
        
        // Use Firestore transaction for atomic operations
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            const userCompletedTasks = userDoc.exists ? userDoc.data().completedTasks || {} : {};
            
            if (userCompletedTasks[taskId]) {
                console.log('❌ User already completed this task (in transaction)');
                throw new Error('ALREADY_COMPLETED');
            }
            
            // Check if task has reached its limit
            if (task.taskLimit > 0 && task.completions >= task.taskLimit) {
                console.log('❌ Task reached completion limit (in transaction)');
                throw new Error('TASK_LIMIT_REACHED');
            }
            
            console.log('✅ Task can be completed, proceeding with transaction...');
            
            // ✅ MARK AS COMPLETED FIRST to prevent duplicates
            transaction.update(userRef, {
                [`completedTasks.${taskId}`]: true,
                last_activity: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Update task completions
            transaction.update(tasksCollection.doc(taskId), {
                completions: admin.firestore.FieldValue.increment(1),
                completedBy: admin.firestore.FieldValue.arrayUnion(userId.toString())
            });
        });
        
        console.log('✅ Transaction completed successfully');
        
        // Now update user balance (outside transaction for better performance)
        const balanceUpdated = await updateUserBalance(userId, parseInt(amount), {
            type: 'task_reward',
            amount: parseInt(amount),
            description: `Task reward: ${task.title}`,
            taskId: taskId,
            taskType: taskType
        });
        
        if (!balanceUpdated) {
            console.warn('⚠️ Balance update failed, but task was marked as completed');
        }
        
        // Check if task has reached its limit
        const updatedTaskDoc = await tasksCollection.doc(taskId).get();
        const updatedTask = updatedTaskDoc.data();
        
        if (task.taskLimit > 0 && updatedTask.completions >= task.taskLimit) {
            await tasksCollection.doc(taskId).update({
                status: 'completed'
            });
            console.log('✅ Task marked as completed (reached limit)');
        }
        
        console.log('🎉 Task completion process finished successfully');
        
        res.json({ 
            success: true, 
            message: 'Task completed successfully',
            pointsAwarded: amount
        });
        
    } catch (error) {
        console.error('❌ Error completing task:', error);
        
        if (error.message === 'ALREADY_COMPLETED') {
            return res.status(400).json({ 
                success: false, 
                error: 'You have already completed this task' 
            });
        }
        
        if (error.message === 'TASK_LIMIT_REACHED') {
            return res.status(400).json({ 
                success: false, 
                error: 'This task has reached its completion limit' 
            });
        }
        
        res.status(500).json({ 
            success: false, 
            error: 'Failed to complete task: ' + error.message 
        });
    } finally {
        // Always release the lock
        completionLocks.delete(lockKey);
        console.log('🔓 Lock released for:', lockKey);
    }
});

// Fix the backend endpoint - update this in your index.js
app.post('/api/tasks/submit-social', async (req, res) => {
    try {
        console.log('📥 Received social task submission request');
        console.log('Request body:', req.body);

        const { taskId, userId, userData, phoneNumber, username } = req.body;
        
        if (!taskId || !userId) {
            console.log('❌ Missing required fields');
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields: taskId and userId are required' 
            });
        }
        
        // Get task
        const taskDoc = await tasksCollection.doc(taskId).get();
        if (!taskDoc.exists) {
            console.log('❌ Task not found:', taskId);
            return res.status(404).json({ 
                success: false, 
                error: 'Task not found' 
            });
        }
        
        const task = taskDoc.data();
        console.log('✅ Found task:', task.title);
        
        // Check if user already has a pending submission
        const pendingApprovals = task.pendingApprovals || [];
        const existingSubmission = pendingApprovals.find(approval => approval.userId === userId.toString());
        
        if (existingSubmission) {
            console.log('❌ User already has pending submission');
            return res.status(400).json({ 
                success: false, 
                error: 'You already have a pending submission for this task' 
            });
        }
        
        // Check if user already completed this task
        const userDoc = await db.collection('users').doc(userId.toString()).get();
        if (userDoc.exists) {
            const user = userDoc.data();
            const completedTasks = user.completedTasks || {};
            if (completedTasks[taskId]) {
                console.log('❌ User already completed this task');
                return res.status(400).json({ 
                    success: false, 
                    error: 'You have already completed this task' 
                });
            }
        }
        
        // Check if task has reached its limit
        if (task.taskLimit > 0 && (task.completions || 0) >= task.taskLimit) {
            console.log('❌ Task reached completion limit');
            return res.status(400).json({ 
                success: false, 
                error: 'This task has reached its completion limit' 
            });
        }
        
        // Create approval data with regular timestamp (not serverTimestamp)
        const approvalData = {
            userId: userId.toString(),
            userData: userData || {},
            submittedAt: new Date().toISOString() // Use client-side timestamp instead
        };
        
        if (phoneNumber) approvalData.phoneNumber = phoneNumber;
        if (username) approvalData.username = username;
        
        console.log('📝 Adding approval data:', approvalData);
        
        // Update the task with the new pending approval
        await tasksCollection.doc(taskId).update({
            pendingApprovals: admin.firestore.FieldValue.arrayUnion(approvalData)
        });
        
        console.log('✅ Social task submission successful for user:', userId);
        
        res.json({ 
            success: true, 
            message: 'Submission received and pending approval',
            submissionId: taskId + '_' + userId
        });
        
    } catch (error) {
        console.error('❌ Error submitting social task:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error: ' + error.message 
        });
    }
});

// API endpoint to get tasks
app.get('/api/tasks/get', async (req, res) => {
    try {
        const { type, id } = req.query;
        let query = tasksCollection;
        
        if (type) {
            query = query.where('type', '==', type);
        }
        
        if (id) {
            const taskDoc = await tasksCollection.doc(id).get();
            if (taskDoc.exists) {
                return res.json({ success: true, task: taskDoc.data() });
            } else {
                return res.status(404).json({ success: false, error: 'Task not found' });
            }
        }
        
        const snapshot = await query.get();
        const tasks = [];
        snapshot.forEach(doc => {
            tasks.push(doc.data());
        });
        
        res.json({ success: true, tasks: tasks });
    } catch (error) {
        console.error('Error getting tasks:', error);
        res.status(500).json({ success: false, error: 'Failed to get tasks' });
    }
});

// API endpoint to delete task
app.post('/api/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        await tasksCollection.doc(taskId).delete();
        res.json({ success: true, message: 'Task deleted successfully' });
    } catch (error) {
        console.error('Error deleting task:', error);
        res.status(500).json({ success: false, error: 'Failed to delete task' });
    }
});

// Update the task approval endpoint in your index.js
app.post('/api/tasks/approve', async (req, res) => {
    try {
        const { taskId, approvalIndex } = req.body;
        
        const taskDoc = await tasksCollection.doc(taskId).get();
        if (!taskDoc.exists) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        const task = taskDoc.data();
        
        if (!task.pendingApprovals || !task.pendingApprovals[approvalIndex]) {
            return res.status(400).json({ success: false, error: 'Approval not found' });
        }
        
        const approval = task.pendingApprovals[approvalIndex];
        
        // Remove from pending
        const updatedPendingApprovals = [...task.pendingApprovals];
        updatedPendingApprovals.splice(approvalIndex, 1);
        
        // Update completions
        const newCompletions = (task.completions || 0) + 1;
        
        // Add to completedBy array
        const updatedCompletedBy = [...(task.completedBy || [])];
        if (!updatedCompletedBy.includes(approval.userId)) {
            updatedCompletedBy.push(approval.userId);
        }
        
        // Update task in Firestore
        await tasksCollection.doc(taskId).update({
            pendingApprovals: updatedPendingApprovals,
            completions: newCompletions,
            completedBy: updatedCompletedBy
        });
        
        // ✅ CRITICAL: Mark task as completed for this user in their user document
        await db.collection('users').doc(approval.userId).update({
            [`completedTasks.${taskId}`]: true,
            last_activity: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Update user balance
        await updateUserBalance(approval.userId, task.amount, {
            type: 'task_reward',
            amount: task.amount,
            description: `Task reward: ${task.title}`,
            taskId: taskId,
            taskType: task.type
        });
        
        // Check if task has reached its limit
        if (task.taskLimit > 0 && newCompletions >= task.taskLimit) {
            await tasksCollection.doc(taskId).update({
                status: 'completed'
            });
        }
        
        // Notify user via bot
        try {
            await bot.sendMessage(
                approval.userId, 
                `✅ Your ${task.type} task "${task.title}" has been approved! You earned ${task.amount} points.`
            );
        } catch (botError) {
            console.error('Failed to notify user:', botError);
        }
        
        res.json({ 
            success: true, 
            message: 'Task approved successfully',
            pointsAwarded: task.amount
        });
        
    } catch (error) {
        console.error('Error approving task:', error);
        res.status(500).json({ success: false, error: 'Failed to approve task' });
    }
});

// API endpoint to reject task completion
app.post('/api/tasks/reject', async (req, res) => {
    try {
        const { taskId, approvalIndex } = req.body;
        
        const taskDoc = await tasksCollection.doc(taskId).get();
        if (!taskDoc.exists) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        const task = taskDoc.data();
        task.pendingApprovals.splice(approvalIndex, 1);
        
        await tasksCollection.doc(taskId).update({
            pendingApprovals: task.pendingApprovals
        });
        
        res.json({ success: true, message: 'Task rejected successfully' });
    } catch (error) {
        console.error('Error rejecting task:', error);
        res.status(500).json({ success: false, error: 'Failed to reject task' });
    }
});

// API endpoint to get pending approvals
app.get('/api/tasks/pending-approvals', async (req, res) => {
    try {
        const snapshot = await tasksCollection.where('pendingApprovals', '!=', []).get();
        const approvals = [];
        
        snapshot.forEach(doc => {
            const task = doc.data();
            if (task.pendingApprovals && task.pendingApprovals.length > 0) {
                task.pendingApprovals.forEach((approval, index) => {
                    approvals.push({
                        taskId: task.id,
                        taskTitle: task.title,
                        taskType: task.type,
                        taskAmount: task.amount,
                        index: index,
                        ...approval
                    });
                });
            }
        });
        
        res.json({ success: true, approvals: approvals });
    } catch (error) {
        console.error('Error getting pending approvals:', error);
        res.status(500).json({ success: false, error: 'Failed to get pending approvals' });
    }
});

// API endpoint to save configuration
app.post('/api/config/save', async (req, res) => {
    try {
        const { type, config } = req.body;
        await configCollection.doc(type).set(config, { merge: true });
        res.json({ success: true, message: 'Configuration saved successfully' });
    } catch (error) {
        console.error('Error saving configuration:', error);
        res.status(500).json({ success: false, error: 'Failed to save configuration' });
    }
});

// Add this debug endpoint to check task state
app.get('/api/tasks/debug', async (req, res) => {
    try {
        const { taskId, userId } = req.query;
        
        if (!taskId || !userId) {
            return res.status(400).json({ success: false, error: 'Missing taskId or userId' });
        }
        
        // Get task data
        const taskDoc = await tasksCollection.doc(taskId).get();
        const task = taskDoc.exists ? taskDoc.data() : null;
        
        // Get user data
        const userDoc = await db.collection('users').doc(userId.toString()).get();
        const user = userDoc.exists ? userDoc.data() : null;
        
        res.json({
            success: true,
            task: task ? {
                id: taskId,
                title: task.title,
                type: task.type,
                completions: task.completions,
                taskLimit: task.taskLimit,
                completedBy: task.completedBy || [],
                status: task.status
            } : null,
            user: user ? {
                id: userId,
                completedTasks: user.completedTasks || {},
                balance: user.balance || 0
            } : null,
            isCompleted: user ? !!(user.completedTasks || {})[taskId] : false,
            isInCompletedBy: task ? (task.completedBy || []).includes(userId.toString()) : false
        });
        
    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to get all configurations
app.get('/api/config/get-all', async (req, res) => {
    try {
        const snapshot = await configCollection.get();
        const configs = {};
        
        snapshot.forEach(doc => {
            configs[doc.id] = doc.data();
        });
        
        res.json({ success: true, configs: configs });
    } catch (error) {
        console.error('Error getting configurations:', error);
        res.status(500).json({ success: false, error: 'Failed to get configurations' });
    }
});

// API endpoint to approve withdrawal
app.post('/api/withdrawals/approve', async (req, res) => {
    try {
        const { requestId } = req.body;
        
        const withdrawalDoc = await withdrawalsCollection.doc(requestId).get();
        if (!withdrawalDoc.exists) {
            return res.status(404).json({ success: false, error: 'Withdrawal request not found' });
        }
        
        const request = withdrawalDoc.data();
        
        // ✅ FIX: Don't refund on payment failure - keep it pending
        const paymentData = {
            address: request.wallet,
            amount: request.wkcAmount.toString(),
            token: "WKC"
        };
        
        console.log('💰 Processing payment:', paymentData);
        
        const paymentResponse = await fetch('https://bnb-autopayed.onrender.com/api/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(paymentData)
        });
        
        if (!paymentResponse.ok) {
            // ✅ FIX: DON'T REFUND - Keep withdrawal as pending for admin to retry later
            const errorText = await paymentResponse.text();
            console.error('❌ Payment failed but keeping withdrawal pending:', errorText);
            
            // Send failure DM to user (optional - you can remove this if you don't want users to know)
            await sendWithdrawalFailureDM(request.userId, request, `Payment processing delayed. Admin will retry shortly.`);
            
            return res.status(400).json({ 
                success: false, 
                error: `Payment failed: ${errorText}. Withdrawal remains pending for retry.` 
            });
        }
        
        const result = await paymentResponse.json();
        
        if (result.success) {
            // ✅ SUCCESS: Update withdrawal status to approved
            await withdrawalsCollection.doc(requestId).update({
                status: 'approved',
                approvedAt: admin.firestore.FieldValue.serverTimestamp(),
                transactionHash: result.txHash,
                explorerLink: result.explorerLink
            });

            // ✅ Update user's withdrawal history status
            await updateWithdrawalHistoryStatus(request.userId, requestId, 'approved', result.txHash);

            // ✅ SEND SUCCESS DM TO USER
            await sendWithdrawalSuccessDM(request.userId, request, result);
            
            console.log('✅ Withdrawal approved successfully:', result.txHash);
            
            res.json({
                success: true,
                amount: request.wkcAmount,
                wallet: request.wallet,
                txHash: result.txHash,
                explorerLink: result.explorerLink
            });
        } else {
            // ✅ FIX: DON'T REFUND - Keep withdrawal as pending for admin to retry
            console.error('❌ Payment API returned failure but keeping withdrawal pending:', result.error);
            
            // Send failure DM to user (optional - you can remove this if you don't want users to know)
            await sendWithdrawalFailureDM(request.userId, request, `Payment processing delayed. Admin will retry shortly.`);
            
            return res.status(400).json({ 
                success: false, 
                error: result.error || 'Payment failed. Withdrawal remains pending for retry.' 
            });
        }
    } catch (error) {
        console.error('❌ Error approving withdrawal:', error);
        
        // ✅ FIX: DON'T REFUND ON ERROR - Keep withdrawal as pending
        try {
            const withdrawalDoc = await withdrawalsCollection.doc(requestId).get();
            if (withdrawalDoc.exists) {
                const request = withdrawalDoc.data();
                // Send error DM to user (optional - you can remove this if you don't want users to know)
                await sendWithdrawalFailureDM(request.userId, request, `Payment processing delayed due to technical issue. Admin will retry shortly.`);
            }
        } catch (dmError) {
            console.error('Failed to send error DM:', dmError);
        }
        
        res.status(500).json({ 
            success: false, 
            error: `Technical error: ${error.message}. Withdrawal remains pending for retry.` 
        });
    }
});

// ✅ NEW FUNCTION: Send withdrawal success DM
async function sendWithdrawalSuccessDM(userId, request, paymentResult) {
    try {
        const message = `💸 *Withdrawal Successful!*\n\n` +
                       `💰 *Amount Sent:* ${request.wkcAmount} WKC\n` +
                       `📍 *Wallet:* \`${request.wallet}\`\n` +
                       `🆔 *TX Hash:* \`${paymentResult.txHash}\`\n` +
                       `⏰ *Processed:* ${new Date().toLocaleString()}\n\n` +
                       `🔗 [View Transaction](${paymentResult.explorerLink})\n\n` +
                       `✅ Funds have been sent to your wallet!`;

        await bot.sendMessage(userId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        
        console.log(`✅ Withdrawal success DM sent to user ${userId}`);
    } catch (error) {
        console.error('❌ Failed to send withdrawal success DM:', error);
        // Don't throw - DM failure shouldn't affect the withdrawal process
    }
}

// ✅ NEW FUNCTION: Update withdrawal history status in user's document
async function updateWithdrawalHistoryStatus(userId, withdrawalId, status, transactionHash = null) {
    try {
        const userRef = db.collection('users').doc(userId.toString());
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
            const user = userDoc.data();
            const withdrawalHistory = user.withdrawalHistory || [];
            
            // Find and update the specific withdrawal entry
            const updatedHistory = withdrawalHistory.map(entry => {
                // We need a way to identify the withdrawal - using amount and date as identifier
                // Alternatively, you could store withdrawalId in the history
                if (entry.amount && entry.date) {
                    // This is a simple match - you might want to improve this logic
                    const entryDate = new Date(entry.date).getTime();
                    const requestDate = new Date().getTime() - 24 * 60 * 60 * 1000; // Within last 24 hours
                    
                    if (entry.status === 'pending' && entryDate > requestDate) {
                        return {
                            ...entry,
                            status: status,
                            transactionHash: transactionHash,
                            approvedAt: new Date().toISOString()
                        };
                    }
                }
                return entry;
            });
            
            await userRef.update({
                withdrawalHistory: updatedHistory
            });
            
            console.log(`✅ Updated withdrawal history status to ${status} for user ${userId}`);
        }
    } catch (error) {
        console.error('Error updating withdrawal history status:', error);
    }
}

// ✅ NEW FUNCTION: Send withdrawal failure DM
// ✅ UPDATED FUNCTION: Send withdrawal success DM (simpler message)
async function sendWithdrawalSuccessDM(userId, request, paymentResult) {
    try {
        const message = `✅ *Withdrawal Completed!*\n\n` +
                       `💰 *Amount Sent:* ${request.wkcAmount} WKC\n` +
                       `📍 *Wallet:* \`${request.wallet}\`\n\n` +
                       `✅ Funds have been sent to your wallet!`;

        await bot.sendMessage(userId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
        console.log(`✅ Withdrawal success DM sent to user ${userId}`);
    } catch (error) {
        console.error('❌ Failed to send withdrawal success DM:', error);
    }
}

// ✅ NEW FUNCTION: Send withdrawal processing DM (optional - when request is first approved)
async function sendWithdrawalProcessingDM(userId, request) {
    try {
        const message = `🔄 *Withdrawal Processing*\n\n` +
                       `💰 *Amount:* ${request.wkcAmount} WKC\n` +
                       `📍 *Wallet:* \`${request.wallet}\`\n` +
                       `⏰ *Started:* ${new Date().toLocaleString()}\n\n` +
                       `Your withdrawal is being processed. You will receive another notification when it's completed.`;

        await bot.sendMessage(userId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
        console.log(`✅ Withdrawal processing DM sent to user ${userId}`);
    } catch (error) {
        console.error('❌ Failed to send withdrawal processing DM:', error);
    }
}

// API endpoint to reject withdrawal
app.post('/api/withdrawals/reject', async (req, res) => {
    try {
        const { requestId } = req.body;
        
        const withdrawalDoc = await withdrawalsCollection.doc(requestId).get();
        if (!withdrawalDoc.exists) {
            return res.status(404).json({ success: false, error: 'Withdrawal request not found' });
        }
        
        const request = withdrawalDoc.data();
        
        // Refund points
        await updateUserBalance(request.userId, request.amount, {
            type: 'withdrawal_refund',
            amount: request.amount,
            description: 'Withdrawal refund - request rejected'
        });
        
        // Update withdrawal status
        await withdrawalsCollection.doc(requestId).update({
            status: 'rejected',
            rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
            refundedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ 
            success: true, 
            message: 'Withdrawal rejected and points refunded',
            refundedAmount: request.amount
        });
    } catch (error) {
        console.error('Error rejecting withdrawal:', error);
        res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
    }
});

// API endpoint to get pending withdrawals
app.get('/api/withdrawals/pending', async (req, res) => {
    try {
        const snapshot = await withdrawalsCollection.where('status', '==', 'pending').get();
        const withdrawals = [];
        
        snapshot.forEach(doc => {
            withdrawals.push(doc.data());
        });
        
        res.json({ success: true, withdrawals: withdrawals });
    } catch (error) {
        console.error('Error getting pending withdrawals:', error);
        res.status(500).json({ success: false, error: 'Failed to get pending withdrawals' });
    }
});

// API endpoint to update user balance
app.post('/api/user/update-balance', async (req, res) => {
  const { userId, amount, type } = req.body;
  
  if (!userId || !amount || !type) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields' 
    });
  }
  
  try {
    const userRef = db.collection('users').doc(userId.toString());
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const currentBalance = userDoc.data().balance || 0;
    let newBalance;
    
    if (type === 'add') {
      newBalance = currentBalance + parseInt(amount);
    } else if (type === 'deduct') {
      if (currentBalance < parseInt(amount)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Insufficient balance' 
        });
      }
      newBalance = currentBalance - parseInt(amount);
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid operation type' 
      });
    }
    
    await userRef.update({
      balance: newBalance,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({
      success: true,
      newBalance: newBalance,
      previousBalance: currentBalance
    });
  } catch (error) {
    console.error('Error updating balance:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update balance' 
    });
  }
});

// Add this endpoint to your index.js
app.post('/api/telegram/start', async (req, res) => {
  try {
    const { userId, startParam } = req.body;
    
    console.log('🔗 Start parameter received:', { userId, startParam });
    
    if (!userId || !startParam) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing userId or startParam' 
      });
    }
    
    // Parse referral from start parameter
    let referrerId = null;
    
    if (startParam.startsWith('ref')) {
      referrerId = startParam.replace('ref', '');
      console.log('🎯 Referrer ID extracted (ref format):', referrerId);
    } else if (startParam.match(/^\d+$/)) {
      referrerId = startParam;
      console.log('🎯 Referrer ID extracted (direct ID):', referrerId);
    } else {
      console.log('❌ Invalid start parameter format:', startParam);
      return res.json({ 
        success: true, 
        message: 'Invalid referral format' 
      });
    }
    
    // Prevent self-referral
    if (referrerId === userId.toString()) {
      console.log('❌ Self-referral detected');
      return res.json({ 
        success: true, 
        message: 'Self-referral not allowed' 
      });
    }
    
    // Check if referral already processed
    const userRef = db.collection('users').doc(userId.toString());
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.referredBy) {
        console.log('❌ User already referred by someone');
        return res.json({ 
          success: true, 
          message: 'Referral already processed' 
        });
      }
    }
    
    // Process referral bonus
    console.log('🚀 Processing referral bonus...');
    const referralResponse = await fetch(`https://www.echoearn.work/api/user/process-referral`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        referrerId: referrerId,
        referredUserId: userId
      })
    });
    
    const referralResult = await referralResponse.json();
    
    if (referralResult.success) {
      // Mark user as referred
      await userRef.set({
        referredBy: referrerId,
        referralProcessed: true
      }, { merge: true });
      
      console.log('✅ Referral processed successfully');
      res.json({
        success: true,
        message: 'Referral processed successfully',
        bonusAmount: referralResult.bonusAmount
      });
    } else {
      console.error('❌ Referral processing failed:', referralResult.error);
      res.status(500).json({
        success: false,
        error: referralResult.error
      });
    }
    
  } catch (error) {
    console.error('Error processing start parameter:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process start parameter' 
    });
  }
});

// Fix the referral processing endpoint - remove serverTimestamp from arrays
app.post('/api/user/process-referral', async (req, res) => {
  try {
    const { referrerId, referredUserId } = req.body;
    
    if (!referrerId || !referredUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing referrerId or referredUserId' 
      });
    }
    
    console.log(`🎯 Processing referral: ${referrerId} referred ${referredUserId}`);
    
    // Get referral configuration
    const configDoc = await configCollection.doc('points').get();
    const pointsConfig = configDoc.exists ? configDoc.data() : {};
    const referralBonus = parseInt(pointsConfig.friendInvitePoints) || 20;
    
    // Update referrer's balance and referral count
    const referrerRef = db.collection('users').doc(referrerId.toString());
    const referrerDoc = await referrerRef.get();
    
    if (!referrerDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'Referrer not found' 
      });
    }
    
    // Add referral bonus
    await updateUserBalance(referrerId, referralBonus, {
      type: 'referral_bonus',
      amount: referralBonus,
      description: `Referral bonus for inviting user ${referredUserId}`,
      referredUserId: referredUserId,
      timestamp: new Date().toISOString() // Use client timestamp
    });
    
    // Update referral count
    const currentReferrals = referrerDoc.data().referral_count || 0;
    await referrerRef.update({
      referral_count: currentReferrals + 1,
      last_activity: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Add to referral history (use regular timestamp, not serverTimestamp)
    const referralEntry = {
      referredUserId: referredUserId,
      bonusAmount: referralBonus,
      timestamp: new Date().toISOString() // Use regular timestamp for arrays
    };
    
    await referrerRef.update({
      referral_history: admin.firestore.FieldValue.arrayUnion(referralEntry)
    });
    
    console.log(`✅ Referral processed: ${referrerId} earned ${referralBonus} points`);
    
    // Send DM notification
    try {
      await bot.sendMessage(
        referrerId, 
        `🎉 *Referral Bonus!*\n\n👤 Your friend joined using your referral link!\n💰 *Bonus Earned:* ${referralBonus} points\n\nKeep inviting to earn more! 🚀`,
        { parse_mode: 'Markdown' }
      );
      console.log(`✅ Referral DM sent to ${referrerId}`);
    } catch (dmError) {
      console.error('Failed to send referral DM:', dmError);
    }
    
    res.json({
      success: true,
      bonusAmount: referralBonus,
      message: 'Referral processed successfully'
    });
    
  } catch (error) {
    console.error('Error processing referral:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process referral: ' + error.message 
    });
  }
});

// Enhanced referral stats endpoint
app.get('/api/user/referral-stats', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing userId parameter' 
    });
  }
  
  try {
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const userData = userDoc.data();
    const totalInvites = userData.referral_count || 0;
    
    // Get referral bonus amount from config
    const configDoc = await configCollection.doc('points').get();
    const pointsConfig = configDoc.exists ? configDoc.data() : {};
    const bonusPerFriend = parseInt(pointsConfig.friendInvitePoints) || 20;
    
    const totalEarnings = totalInvites * bonusPerFriend;
    
    res.json({
      success: true,
      stats: {
        totalInvites: totalInvites,
        totalEarnings: totalEarnings,
        bonusPerFriend: bonusPerFriend,
        referralHistory: userData.referral_history || []
      }
    });
  } catch (error) {
    console.error('Error getting referral stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get referral stats' 
    });
  }
});

// Team members endpoint (for future multi-level referrals)
app.get('/api/user/team-members', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing userId parameter' 
    });
  }
  
  try {
    // For now, return direct referrals only
    // In future, you can implement multi-level team structure
    const userDoc = await db.collection('users').doc(userId.toString()).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const userData = userDoc.data();
    const referralHistory = userData.referral_history || [];
    
    // Get details for each referred user
    const teamMembers = await Promise.all(
      referralHistory.map(async (referral) => {
        try {
          const referredUserDoc = await db.collection('users').doc(referral.referredUserId.toString()).get();
          if (referredUserDoc.exists) {
            const referredUser = referredUserDoc.data();
            return {
              userId: referral.referredUserId,
              username: referredUser.username || referredUser.first_name,
              joinDate: referredUser.join_date,
              bonusEarned: referral.bonusAmount,
              level: 1 // Direct referral
            };
          }
        } catch (error) {
          console.error('Error getting referred user:', error);
        }
        return null;
      })
    );
    
    res.json({
      success: true,
      teamMembers: teamMembers.filter(member => member !== null)
    });
  } catch (error) {
    console.error('Error getting team members:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get team members' 
    });
  }
});

// API endpoint to process withdrawals (proxy to avoid CORS)
app.post('/api/process-withdrawal', async (req, res) => {
  try {
    const { address, amount, token } = req.body;
    
    console.log('💰 Processing withdrawal:', { address, amount, token });
    
    if (!address || !amount || !token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: address, amount, token' 
      });
    }
    
    // Validate BSC address format
    if (!address.startsWith('0x') || address.length !== 42) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid BSC address format' 
      });
    }
    
    // Send request to payment API
    const paymentData = {
      address: address,
      amount: amount.toString(),
      token: token
    };
    
    console.log('🔄 Sending to payment API:', paymentData);
    
    const paymentResponse = await fetch('https://bnb-autopayed.onrender.com/api/pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentData)
    });
    
    if (!paymentResponse.ok) {
      const errorText = await paymentResponse.text();
      console.error('❌ Payment API error:', errorText);
      throw new Error(`Payment API returned ${paymentResponse.status}: ${errorText}`);
    }
    
    const result = await paymentResponse.json();
    
    console.log('✅ Payment API response:', result);
    
    if (result.success) {
      res.json({
        success: true,
        txHash: result.txHash,
        explorerLink: result.explorerLink,
        gasCost: result.gasCost
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error || 'Payment failed'
      });
    }
    
  } catch (error) {
    console.error('❌ Withdrawal processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to send messages via bot
app.post('/api/bot/send-message', async (req, res) => {
  try {
    const { userId, message } = req.body;
    
    if (!userId || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing userId or message' 
      });
    }
    
    await bot.sendMessage(userId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    
    res.json({
      success: true,
      message: 'Message sent successfully'
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
});

// API endpoint to get withdrawal requests (for admin)
app.get('/api/withdrawals/pending', async (req, res) => {
  try {
    // In a real app, you'd get this from your database
    // For now, we'll return a mock response
    res.json({
      success: true,
      withdrawals: []
    });
  } catch (error) {
    console.error('Error getting withdrawals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get withdrawals'
    });
  }
});

// Basic error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  
  try {
    const webhookUrl = `https://www.echoearn.work/bot${botToken}`;
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set successfully');
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
});