const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3001;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

// Bot configuration
const botToken = '8488159096:AAHnzzdhE2wrIKCS5OtR2o3K_1Cw3PL38kg';
const adminId = '5650788149';
const bot = new TelegramBot(botToken);

// ✅ ADD THESE LINES FOR AUTHENTICATION
const ALLOWED_USER_IDS = ['5650788149', '7659022836'];
const activePasswords = new Map();
const completionLocks = new Map();

// Channel configuration
const channels = {
  'EchoEarn': '-1002586398527',
  'Tapy': '-1001605359797'
};

function generateOneTimePassword() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Helper functions for Supabase
async function loadUsers() {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*');
    
    if (error) throw error;
    
    const usersMap = {};
    users.forEach(user => {
      usersMap[user.id] = user;
    });
    return usersMap;
  } catch (error) {
    console.error('Error loading user data from Supabase:', error);
    return {};
  }
}

async function saveUser(userId, userData) {
  try {
    const { data, error } = await supabase
      .from('users')
      .upsert({
        id: userId.toString(),
        ...userData,
        updated_at: new Date().toISOString()
      });
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error saving user to Supabase:', error);
    return false;
  }
}

async function addUser(userId, userData = {}) {
  try {
    // Check if user exists
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId.toString())
      .single();
    
    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = no rows
      throw fetchError;
    }
    
    if (!existingUser) {
      // Create new user
      const newUser = {
        id: userId.toString(),
        username: userData.username || '',
        first_name: userData.first_name || '',
        last_name: userData.last_name || '',
        verified: true,
        join_date: new Date().toISOString(),
        last_verified: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        balance: 0,
        transactions: [],
        processed_events: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabase
        .from('users')
        .insert([newUser]);
      
      if (error) throw error;
      console.log(`✅ New user added to Supabase: ${userId}`);
      return true;
    } else {
      // Update existing user
      const updateData = {
        verified: true,
        last_verified: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      // Update user info if provided
      if (userData.username) updateData.username = userData.username;
      if (userData.first_name) updateData.first_name = userData.first_name;
      if (userData.last_name) updateData.last_name = userData.last_name;
      
      const { error } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId.toString());
      
      if (error) throw error;
      return true;
    }
  } catch (error) {
    console.error('Error adding/updating user in Supabase:', error);
    return false;
  }
}

async function getUser(userId) {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId.toString())
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') return null; // No user found
      throw error;
    }
    
    return user;
  } catch (error) {
    console.error('Error getting user from Supabase:', error);
    return null;
  }
}

async function updateUserVerification(userId, status) {
  try {
    const { error } = await supabase
      .from('users')
      .update({
        verified: status,
        last_verified: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', userId.toString());
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error updating user verification:', error);
    return false;
  }
}

async function updateUserBalance(userId, amount, transactionData = null) {
  try {
    console.log(`💰 Updating balance for user ${userId}: +${amount} points`);
    
    // First get current balance
    const user = await getUser(userId.toString());
    const currentBalance = user ? user.balance : 0;
    
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
      
      // Update balance and add transaction
      const { error } = await supabase
        .from('users')
        .update({
          balance: currentBalance + amount,
          transactions: [...(user.transactions || []), transaction],
          last_activity: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', userId.toString());
      
      if (error) throw error;
    } else {
      // Just update balance
      const { error } = await supabase
        .from('users')
        .update({
          balance: currentBalance + amount,
          last_activity: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', userId.toString());
      
      if (error) throw error;
    }
    
    // Verify the update worked
    const updatedUser = await getUser(userId.toString());
    const newBalance = updatedUser ? updatedUser.balance : 0;
    
    console.log(`✅ Balance update successful! New balance: ${newBalance}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error updating user balance:', error);
    console.error('Error details:', error.message);
    return false;
  }
}

// Withdrawal DM function
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
    
    if (text === '/getcode') {
        console.log(`🔐 /getcode command received from user: ${userId}`);
        
        const userIdStr = userId.toString();
        
        if (ALLOWED_USER_IDS.includes(userIdStr)) {
            const password = generateOneTimePassword();
            const timestamp = Date.now();
            
            activePasswords.set(userIdStr, {
                password: password,
                timestamp: timestamp
            });
            
            const message = `🔐 *Admin Panel Access Code*\n\n` +
                          `👤 User ID: ${userIdStr}\n` +
                          `🔑 One-Time Password: *${password}*\n\n` +
                          `⏰ *Expires in 5 minutes*\n\n` +
                          `💡 Go to your admin panel and use this code to login.`;
            
            await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
            console.log(`✅ Password sent to user ${userIdStr}: ${password}`);
        } else {
            console.log(`❌ Unauthorized /getcode attempt from user: ${userIdStr}`);
            await bot.sendMessage(userId, "❌ Access denied. You are not authorized to use this command.");
        }
        return;
    }

    // Handle /start command with referral parameter
    if (text.startsWith('/start')) {
      const startParam = text.split(' ')[1];
      
      let welcomeMessage = `👋 Welcome to EchoEARN Bot!\n\n`;
      welcomeMessage += `🎯 <b>Earn points by completing simple tasks</b>\n`;
      welcomeMessage += `💰 <b>Withdraw your earnings easily</b>\n\n`;
      
      if (startParam) {
        console.log(`🔗 Start parameter detected: ${startParam}`);
        
        let referrerId = null;
        
        if (startParam.startsWith('ref')) {
          referrerId = startParam.replace('ref', '');
        } else if (startParam.match(/^\d+$/)) {
          referrerId = startParam;
        }
        
        if (referrerId && referrerId !== userId.toString()) {
          console.log(`🎯 Processing referral: ${referrerId} -> ${userId}`);
          
          const user = await getUser(userId.toString());
          
          // ✅ STRONG VALIDATION: Check if user already has a referrer
          if (user && user.referred_by) {
            console.log(`❌ Referral blocked: User ${userId} already referred by ${user.referred_by}`);
          } 
          // ✅ Check if referral already processed
          else if (user && user.referral_processed) {
            console.log(`❌ Referral blocked: Already processed for user ${userId}`);
          }
          // ✅ Check if user is trying to refer themselves
          else if (referrerId === userId.toString()) {
            console.log(`❌ Self-referral blocked: ${userId}`);
          }
          // ✅ Process new referral
          else {
            const referralSuccess = await processReferralInBot(referrerId, userId.toString());
            
            if (referralSuccess) {
              welcomeMessage += `🎉 <b>You joined via referral! Your friend earned bonus points.</b>\n\n`;
              
              await saveUser(userId.toString(), {
                referred_by: referrerId,
                referral_processed: true,
                referral_processed_at: new Date().toISOString(),
                joined_via: 'referral'
              });
              
              console.log(`✅ New referral processed: ${referrerId} -> ${userId}`);
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

// Process referral function
async function processReferralInBot(referrerId, referredUserId) {
  try {
    console.log(`💰 Processing referral in bot: ${referrerId} referred ${referredUserId}`);
    
    // ✅ PREVENT SELF-REFERRAL
    if (referrerId === referredUserId) {
      console.log('❌ Self-referral blocked');
      return false;
    }
    
    // ✅ CHECK IF REFERRAL ALREADY PROCESSED FOR THIS USER
    const referredUser = await getUser(referredUserId.toString());
    if (referredUser && referredUser.referred_by) {
      console.log('❌ User already has a referrer:', referredUser.referred_by);
      return false;
    }
    
    // ✅ CHECK IF THIS SPECIFIC REFERRAL WAS ALREADY PROCESSED
    if (referredUser && referredUser.referral_processed) {
      console.log('❌ Referral already processed for this user');
      return false;
    }
    
    // ✅ CHECK IF REFERRER EXISTS
    const referrer = await getUser(referrerId.toString());
    if (!referrer) {
      console.log('❌ Referrer not found in database');
      return false;
    }
    
    // ✅ CHECK FOR DUPLICATE IN REFERRAL HISTORY
    const referralHistory = referrer.referral_history || [];
    const alreadyReferred = referralHistory.some(ref => 
      ref.referredUserId === referredUserId.toString()
    );
    
    if (alreadyReferred) {
      console.log('❌ This user was already referred by this referrer');
      return false;
    }
    
    // Get referral configuration
    const { data: config, error: configError } = await supabase
      .from('configurations')
      .select('config')
      .eq('id', 'points')
      .single();
    
    const pointsConfig = config ? config.config : {};
    const referralBonus = parseInt(pointsConfig.friendInvitePoints) || 20;
    
    // ✅ ADD REFERRAL BONUS
    await updateUserBalance(referrerId, referralBonus, {
      type: 'referral_bonus',
      amount: referralBonus,
      description: `Referral bonus for inviting user ${referredUserId}`,
      referredUserId: referredUserId,
      timestamp: new Date().toISOString()
    });
    
    // ✅ UPDATE REFERRAL COUNT
    const currentReferrals = referrer.referral_count || 0;
    await saveUser(referrerId.toString(), {
      referral_count: currentReferrals + 1,
      referral_history: [
        ...referralHistory,
        {
          referredUserId: referredUserId,
          bonusAmount: referralBonus,
          timestamp: new Date().toISOString()
        }
      ]
    });
    
    console.log(`✅ Referral processed in bot: ${referrerId} earned ${referralBonus} points`);
    
    // ✅ SEND DM NOTIFICATION TO REFERRER
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
    const channelsArray = JSON.parse(channelIds);
    const membershipStatus = {};
    const numericUserId = parseInt(userId);

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

    const allJoined = Object.values(membershipStatus).every(status => status === true);
    if (allJoined) {
      await addUser(userId.toString());
      
      try {
        await bot.sendMessage(adminId, `✅ User ${numericUserId} has successfully joined all channels!`);
      } catch (adminError) {
        console.error('Failed to notify admin:', adminError);
      }
    } else {
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

        if (!telegram_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing telegram_id parameter' 
            });
        }

        if (event_type !== 'click') {
            console.log('ℹ️ Ignoring non-click event:', event_type);
            return res.status(200).json({ 
                success: true, 
                message: 'Ignoring non-click event' 
            });
        }

        if (reward_event_type !== 'valued') {
            console.log('ℹ️ Ignoring unpaid event:', reward_event_type);
            return res.status(200).json({ 
                success: true, 
                message: 'Ignoring unpaid event' 
            });
        }

        const numericTelegramId = telegram_id.toString();
        let user = await getUser(numericTelegramId);
        
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

        if (user.processed_events && user.processed_events.includes(ymid)) {
            console.log('⚠️ Event already processed:', ymid);
            return res.status(200).json({ 
                success: true, 
                message: 'Event already processed' 
            });
        }

        const rewardPoints = 30;

        const transaction = {
            type: 'ad_reward',
            amount: rewardPoints,
            description: `Ad reward from ${request_var || 'unknown_location'}`,
            estimatedPrice: estimated_price ? parseFloat(estimated_price) : 0,
            zoneId: zone_id,
            subZoneId: sub_zone_id,
            eventId: ymid
        };

        const oldBalance = user.balance || 0;
        
        const updatedUserData = {
            processed_events: [...(user.processed_events || []), ymid],
            last_activity: new Date().toISOString()
        };

        await saveUser(numericTelegramId, updatedUserData);
        await updateUserBalance(numericTelegramId, rewardPoints, transaction);

        console.log(`✅ Reward added: ${rewardPoints} points to user ${telegram_id}. Balance: ${oldBalance} → ${oldBalance + rewardPoints}`);

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
        const { data: users, error } = await supabase
            .from('users')
            .select('id');
        
        if (error) throw error;
        
        const userCount = users.length;
        let sentCount = 0;
        let failedCount = 0;

        console.log(`📢 Sending task notification to ${userCount} users...`);

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

        for (const user of users) {
            try {
                await bot.sendMessage(user.id, message, { parse_mode: 'HTML' });
                sentCount++;
                console.log(`✅ Notification sent to user ${user.id}`);
                
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`❌ Failed to send notification to user ${user.id}:`, error.message);
                failedCount++;
            }
        }

        console.log(`📊 Notification summary: ${sentCount} sent, ${failedCount} failed`);

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
        const { count, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        
        if (error) throw error;
        
        res.json({
            success: true,
            userCount: count,
            activeUsers: count
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
    
    const { data: withdrawals, error } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('user_id', userId.toString())
      .eq('status', 'pending')
      .limit(1);
    
    if (error) throw error;
    
    const hasPending = withdrawals && withdrawals.length > 0;
    
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

// API endpoint to add balance
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
    
    const transactionData = {
      type: type,
      amount: parseInt(amount),
      description: description || `Ad reward completion`,
      timestamp: new Date().toISOString()
    };
    
    const success = await updateUserBalance(userId, parseInt(amount), transactionData);
    
    if (success) {
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

// API endpoint to get wallet data
app.get('/api/user/wallet-data', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.json({ 
        success: true, 
        walletData: null 
      });
    }
    
    res.json({
      success: true,
      walletData: user.wallet_data || null
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
    
    await saveUser(userId.toString(), {
      wallet_data: walletData
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
    
    const transactionData = {
      type: 'wallet_edit_fee',
      amount: -parseInt(amount),
      description: description || 'Wallet edit fee',
      timestamp: new Date().toISOString()
    };
    
    const success = await updateUserBalance(userId, -parseInt(amount), transactionData);
    
    if (success) {
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

// API endpoint to get user's pending withdrawals total
app.get('/api/withdrawals/user-pending', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter' });
    }
    
    const { data: withdrawals, error } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('user_id', userId.toString())
      .eq('status', 'pending');
    
    if (error) throw error;
    
    let totalPending = 0;
    withdrawals.forEach(withdrawal => {
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
app.post('/api/withdrawals/create', async (req, res) => {
  try {
    const withdrawalRequest = req.body;
    
    if (!withdrawalRequest.userId || !withdrawalRequest.amount || !withdrawalRequest.wallet) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const { error } = await supabase
      .from('withdrawals')
      .insert([{
        id: withdrawalRequest.id,
        user_id: withdrawalRequest.userId,
        username: withdrawalRequest.username,
        amount: withdrawalRequest.amount,
        wkc_amount: withdrawalRequest.wkcAmount,
        wallet: withdrawalRequest.wallet,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);
    
    if (error) throw error;
    
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
    
    const user = await getUser(userId.toString());
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const updatedHistory = [...(user.withdrawal_history || []), withdrawalEntry];
    
    await saveUser(userId.toString(), {
      withdrawal_history: updatedHistory
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
    
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.json({ 
        success: true, 
        withdrawalHistory: [] 
      });
    }
    
    res.json({
      success: true,
      withdrawalHistory: user.withdrawal_history || []
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
    
    const user = await getUser(userId.toString());
    
    if (!user) {
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
    
    res.json({
      success: true,
      dailyRewardsData: user.daily_rewards_data || {
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
    
    await saveUser(userId.toString(), {
      daily_rewards_data: dailyRewardsData
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

// API endpoint to send password
app.post('/api/admin/send-password', async (req, res) => {
    try {
        const { userId, password } = req.body;
        
        console.log('🔐 Password request received for user:', userId);
        
        if (!userId || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing userId or password' 
            });
        }
        
        if (!ALLOWED_USER_IDS.includes(userId)) {
            console.log('❌ Unauthorized user attempt:', userId);
            return res.status(403).json({ 
                success: false, 
                error: 'User not authorized' 
            });
        }
        
        console.log('✅ Authorized user, sending password via bot...');
        
        const message = `🔐 *Admin Panel Access Code*\n\n` +
                      `👤 User ID: ${userId}\n` +
                      `🔑 One-Time Password: *${password}*\n\n` +
                      `⏰ *Expires in 5 minutes*\n\n` +
                      `💡 Use this code to login to your admin panel.`;
        
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        
        console.log('✅ Password sent successfully to user:', userId);
        
        res.json({ 
            success: true, 
            message: 'Password sent successfully' 
        });
        
    } catch (error) {
        console.error('❌ Error sending password:', error);
        
        if (error.response && error.response.statusCode === 403) {
            return res.status(500).json({ 
                success: false, 
                error: 'User has blocked the bot or chat not found' 
            });
        }
        
        if (error.response && error.response.statusCode === 400) {
            return res.status(500).json({ 
                success: false, 
                error: 'Invalid user ID format' 
            });
        }
        
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send password: ' + error.message 
        });
    }
});

// Debug endpoint to check bot status
app.get('/api/admin/debug', async (req, res) => {
    try {
        const botInfo = await bot.getMe();
        res.json({
            success: true,
            botInfo: botInfo,
            allowedUsers: ALLOWED_USER_IDS,
            activePasswords: Array.from(activePasswords.entries())
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Bot error: ' + error.message
        });
    }
});

// Test message endpoint
app.post('/api/admin/test-message', async (req, res) => {
    try {
        const { userId, message } = req.body;
        
        if (!userId || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing userId or message' 
            });
        }
        
        await bot.sendMessage(userId, `Test message: ${message}`);
        
        res.json({ 
            success: true, 
            message: 'Test message sent successfully' 
        });
        
    } catch (error) {
        console.error('Error sending test message:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send test message: ' + error.message 
        });
    }
});

// Leaderboard API endpoints
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, first_name, balance, referral_count')
      .order('balance', { ascending: false })
      .limit(10);
    
    if (error) throw error;
    
    const leaderboard = users.map(user => ({
      id: user.id,
      username: user.username || user.first_name,
      balance: user.balance || 0,
      referral_count: user.referral_count || 0
    }));
    
    let userRank = '?';
    if (userId) {
      const user = await getUser(userId.toString());
      if (user) {
        const userBalance = user.balance || 0;
        
        const { data: higherUsers, error: countError } = await supabase
          .from('users')
          .select('id', { count: 'exact' })
          .gt('balance', userBalance);
        
        if (!countError) {
          userRank = higherUsers.length + 1;
        }
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
    
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.json({ 
        success: true, 
        rank: '?' 
      });
    }
    
    const userBalance = user.balance || 0;
    
    const { data: higherUsers, error } = await supabase
      .from('users')
      .select('id', { count: 'exact' })
      .gt('balance', userBalance);
    
    if (error) throw error;
    
    const rank = higherUsers.length + 1;
    
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
    
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.json({ 
        success: true, 
        adsTaskData: {
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
    
    const adsTaskData = user.ads_task_data || user.ads_data || {
      lastAdDate: '',
      adsToday: 0,
      lastAdHour: -1,
      adsThisHour: 0,
      lifetimeAds: 0,
      totalEarnings: 0,
      history: []
    };
    
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
    
    const user = await getUser(userId.toString());
    
    if (!user) {
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
    
    res.json({
      success: true,
      adsData: user.ads_data || {
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
    
    await saveUser(userId.toString(), {
      ads_task_data: adsTaskData
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
    
    await saveUser(userId.toString(), {
      ads_data: adsData
    });
    
    res.json({ success: true, message: 'Ads data saved successfully' });
  } catch (error) {
    console.error('Error saving ads data:', error);
    res.status(500).json({ success: false, error: 'Failed to save ads data' });
  }
});

// Add this endpoint to check user transactions
app.get('/api/user/transactions', async (req, res) => {
    try {
        const { userId } = req.query;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'Missing userId parameter' });
        }
        
        const user = await getUser(userId.toString());
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({
            success: true,
            userId: userId,
            balance: user.balance || 0,
            transactions: user.transactions || [],
            completedTasks: user.completed_tasks || {},
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
        
        const { error } = await supabase
            .from('tasks')
            .upsert([{
                id: task.id,
                title: task.title,
                description: task.description,
                amount: task.amount,
                verification: task.verification,
                link: task.link,
                channel_id: task.channelId,
                task_limit: task.taskLimit || 0,
                completions: task.completions || 0,
                completed_by: task.completedBy || [],
                type: task.type,
                status: task.status || 'active',
                pending_approvals: task.pendingApprovals || [],
                created_at: task.createdAt || new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);
        
        if (error) throw error;
        
        res.json({ success: true, message: 'Task saved successfully' });
    } catch (error) {
        console.error('Error saving task:', error);
        res.status(500).json({ success: false, error: 'Failed to save task' });
    }
});

// API endpoint to get task link
app.get('/api/tasks/get-link', async (req, res) => {
    try {
        const { taskId } = req.query;
        
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'Missing taskId parameter' });
        }
        
        const { data: task, error } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        
        if (error) throw error;
        if (!task) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
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
        
        const user = await getUser(userId.toString());
        if (!user) {
            return res.json({ success: true, completed: false });
        }
        
        const completedTasks = user.completed_tasks || {};
        const isCompleted = !!completedTasks[taskId];
        
        if (!isCompleted) {
            const { data: task, error } = await supabase
                .from('tasks')
                .select('completed_by')
                .eq('id', taskId)
                .single();
            
            if (!error && task) {
                const completedBy = task.completed_by || [];
                if (completedBy.includes(userId.toString())) {
                    await saveUser(userId.toString(), {
                        completed_tasks: { ...completedTasks, [taskId]: true }
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

// API endpoint to migrate existing completed tasks to the new system
app.post('/api/tasks/migrate-completed', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'Missing userId' });
        }
        
        const { data: tasks, error: tasksError } = await supabase
            .from('tasks')
            .select('id, completed_by');
        
        if (tasksError) throw tasksError;
        
        const user = await getUser(userId.toString());
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        let migratedCount = 0;
        const completedTasks = { ...user.completed_tasks };
        
        for (const task of tasks) {
            const completedBy = task.completed_by || [];
            if (completedBy.includes(userId.toString())) {
                completedTasks[task.id] = true;
                migratedCount++;
            }
        }
        
        await saveUser(userId.toString(), {
            completed_tasks: completedTasks
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
        
        const { data: task, error } = await supabase
            .from('tasks')
            .select('pending_approvals')
            .eq('id', taskId)
            .single();
        
        if (error) throw error;
        if (!task) {
            return res.json({ success: true, pending: false });
        }
        
        const pendingApprovals = task.pending_approvals || [];
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
    
    const lockKey = `${userId}_${taskId}`;
    
    if (completionLocks.has(lockKey)) {
        console.log('⏳ Request already in progress, skipping duplicate:', lockKey);
        return res.status(429).json({ 
            success: false, 
            error: 'Request already being processed' 
        });
    }
    
    completionLocks.set(lockKey, true);
    
    try {
        console.log('🔄 Processing task completion:', { taskId, userId, amount, taskType });
        
        if (!taskId || !userId || !amount) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        const { data: task, error: taskError } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        
        if (taskError) throw taskError;
        if (!task) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        console.log('📋 Task details:', task.title, 'Completions:', task.completions, 'Limit:', task.task_limit);
        
        const user = await getUser(userId.toString());
        const userCompletedTasks = user ? user.completed_tasks || {} : {};
        
        if (userCompletedTasks[taskId]) {
            console.log('❌ User already completed this task');
            throw new Error('ALREADY_COMPLETED');
        }
        
        if (task.task_limit > 0 && task.completions >= task.task_limit) {
            console.log('❌ Task reached completion limit');
            throw new Error('TASK_LIMIT_REACHED');
        }
        
        console.log('✅ Task can be completed, proceeding...');
        
        // Mark as completed
        await saveUser(userId.toString(), {
            completed_tasks: { ...userCompletedTasks, [taskId]: true }
        });
        
        // Update task completions
        const { error: updateError } = await supabase
            .from('tasks')
            .update({
                completions: task.completions + 1,
                completed_by: [...(task.completed_by || []), userId.toString()],
                updated_at: new Date().toISOString()
            })
            .eq('id', taskId);
        
        if (updateError) throw updateError;
        
        console.log('✅ Transaction completed successfully');
        
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
        
        if (task.task_limit > 0 && (task.completions + 1) >= task.task_limit) {
            await supabase
                .from('tasks')
                .update({
                    status: 'completed',
                    updated_at: new Date().toISOString()
                })
                .eq('id', taskId);
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
        completionLocks.delete(lockKey);
        console.log('🔓 Lock released for:', lockKey);
    }
});

// Fix the backend endpoint for social task submission
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
        
        const { data: task, error: taskError } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        
        if (taskError) throw taskError;
        if (!task) {
            console.log('❌ Task not found:', taskId);
            return res.status(404).json({ 
                success: false, 
                error: 'Task not found' 
            });
        }
        
        console.log('✅ Found task:', task.title);
        
        const pendingApprovals = task.pending_approvals || [];
        const existingSubmission = pendingApprovals.find(approval => approval.userId === userId.toString());
        
        if (existingSubmission) {
            console.log('❌ User already has pending submission');
            return res.status(400).json({ 
                success: false, 
                error: 'You already have a pending submission for this task' 
            });
        }
        
        const user = await getUser(userId.toString());
        if (user) {
            const completedTasks = user.completed_tasks || {};
            if (completedTasks[taskId]) {
                console.log('❌ User already completed this task');
                return res.status(400).json({ 
                    success: false, 
                    error: 'You have already completed this task' 
                });
            }
        }
        
        if (task.task_limit > 0 && (task.completions || 0) >= task.task_limit) {
            console.log('❌ Task reached completion limit');
            return res.status(400).json({ 
                success: false, 
                error: 'This task has reached its completion limit' 
            });
        }
        
        const approvalData = {
            userId: userId.toString(),
            userData: userData || {},
            submittedAt: new Date().toISOString()
        };
        
        if (phoneNumber) approvalData.phoneNumber = phoneNumber;
        if (username) approvalData.username = username;
        
        console.log('📝 Adding approval data:', approvalData);
        
        const { error: updateError } = await supabase
            .from('tasks')
            .update({
                pending_approvals: [...pendingApprovals, approvalData],
                updated_at: new Date().toISOString()
            })
            .eq('id', taskId);
        
        if (updateError) throw updateError;
        
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
        
        if (id) {
            const { data: task, error } = await supabase
                .from('tasks')
                .select('*')
                .eq('id', id)
                .single();
            
            if (error) throw error;
            
            if (task) {
                return res.json({ success: true, task: task });
            } else {
                return res.status(404).json({ success: false, error: 'Task not found' });
            }
        }
        
        let query = supabase.from('tasks').select('*');
        
        if (type) {
            query = query.eq('type', type);
        }
        
        const { data: tasks, error } = await query;
        
        if (error) throw error;
        
        res.json({ success: true, tasks: tasks || [] });
    } catch (error) {
        console.error('Error getting tasks:', error);
        res.status(500).json({ success: false, error: 'Failed to get tasks' });
    }
});

// API endpoint to delete task
app.post('/api/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        
        const { error } = await supabase
            .from('tasks')
            .delete()
            .eq('id', taskId);
        
        if (error) throw error;
        
        res.json({ success: true, message: 'Task deleted successfully' });
    } catch (error) {
        console.error('Error deleting task:', error);
        res.status(500).json({ success: false, error: 'Failed to delete task' });
    }
});

// Update the task approval endpoint
app.post('/api/tasks/approve', async (req, res) => {
    try {
        const { taskId, approvalIndex } = req.body;
        
        const { data: task, error: taskError } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        
        if (taskError) throw taskError;
        if (!task) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        if (!task.pending_approvals || !task.pending_approvals[approvalIndex]) {
            return res.status(400).json({ success: false, error: 'Approval not found' });
        }
        
        const approval = task.pending_approvals[approvalIndex];
        
        const updatedPendingApprovals = [...task.pending_approvals];
        updatedPendingApprovals.splice(approvalIndex, 1);
        
        const newCompletions = (task.completions || 0) + 1;
        
        const updatedCompletedBy = [...(task.completed_by || [])];
        if (!updatedCompletedBy.includes(approval.userId)) {
            updatedCompletedBy.push(approval.userId);
        }
        
        const { error: updateError } = await supabase
            .from('tasks')
            .update({
                pending_approvals: updatedPendingApprovals,
                completions: newCompletions,
                completed_by: updatedCompletedBy,
                updated_at: new Date().toISOString()
            })
            .eq('id', taskId);
        
        if (updateError) throw updateError;
        
        await saveUser(approval.userId, {
            completed_tasks: { ...(await getUser(approval.userId))?.completed_tasks, [taskId]: true }
        });
        
        await updateUserBalance(approval.userId, task.amount, {
            type: 'task_reward',
            amount: task.amount,
            description: `Task reward: ${task.title}`,
            taskId: taskId,
            taskType: task.type
        });
        
        if (task.task_limit > 0 && newCompletions >= task.task_limit) {
            await supabase
                .from('tasks')
                .update({
                    status: 'completed',
                    updated_at: new Date().toISOString()
                })
                .eq('id', taskId);
        }
        
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
        
        const { data: task, error: taskError } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        
        if (taskError) throw taskError;
        if (!task) {
            return res.status(404).json({ success: false, error: 'Task not found' });
        }
        
        const updatedPendingApprovals = [...task.pending_approvals];
        updatedPendingApprovals.splice(approvalIndex, 1);
        
        const { error: updateError } = await supabase
            .from('tasks')
            .update({
                pending_approvals: updatedPendingApprovals,
                updated_at: new Date().toISOString()
            })
            .eq('id', taskId);
        
        if (updateError) throw updateError;
        
        res.json({ success: true, message: 'Task rejected successfully' });
    } catch (error) {
        console.error('Error rejecting task:', error);
        res.status(500).json({ success: false, error: 'Failed to reject task' });
    }
});

// API endpoint to get pending approvals
app.get('/api/tasks/pending-approvals', async (req, res) => {
    try {
        const { data: tasks, error } = await supabase
            .from('tasks')
            .select('*')
            .not('pending_approvals', 'is', null);
        
        if (error) throw error;
        
        const approvals = [];
        
        tasks.forEach(task => {
            if (task.pending_approvals && task.pending_approvals.length > 0) {
                task.pending_approvals.forEach((approval, index) => {
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
        
        const { error } = await supabase
            .from('configurations')
            .upsert([{
                id: type,
                config: config,
                updated_at: new Date().toISOString()
            }]);
        
        if (error) throw error;
        
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
        
        const { data: task, error: taskError } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', taskId)
            .single();
        
        const user = await getUser(userId.toString());
        
        res.json({
            success: true,
            task: task ? {
                id: taskId,
                title: task.title,
                type: task.type,
                completions: task.completions,
                taskLimit: task.task_limit,
                completedBy: task.completed_by || [],
                status: task.status
            } : null,
            user: user ? {
                id: userId,
                completedTasks: user.completed_tasks || {},
                balance: user.balance || 0
            } : null,
            isCompleted: user ? !!(user.completed_tasks || {})[taskId] : false,
            isInCompletedBy: task ? (task.completed_by || []).includes(userId.toString()) : false
        });
        
    } catch (error) {
        console.error('Error in debug endpoint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to get all configurations
app.get('/api/config/get-all', async (req, res) => {
    try {
        const { data: configs, error } = await supabase
            .from('configurations')
            .select('*');
        
        if (error) throw error;
        
        const configsMap = {};
        configs.forEach(config => {
            configsMap[config.id] = config.config;
        });
        
        res.json({ success: true, configs: configsMap });
    } catch (error) {
        console.error('Error getting configurations:', error);
        res.status(500).json({ success: false, error: 'Failed to get configurations' });
    }
});

// Withdrawal success DM function
async function sendWithdrawalSuccessDM(userId, request, paymentResult) {
    try {
        const message = `✅ *Withdrawal Completed!*\n\n` +
                       `💰 *Amount Sent:* ${request.wkc_amount} WKC\n` +
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

// Withdrawal failure DM function
async function sendWithdrawalFailureDM(userId, request, errorMessage) {
    try {
        console.log(`⚠️ Withdrawal processing delayed for user ${userId}: ${errorMessage}`);
        
        const message = `🔄 *Withdrawal Processing*\n\n` +
                       `💰 *Amount:* ${request.wkc_amount} WKC\n` +
                       `📍 *Wallet:* \`${request.wallet}\`\n\n` +
                       `Your withdrawal is being processed and will be completed shortly.`;

        await bot.sendMessage(userId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
    } catch (error) {
        console.error('❌ Failed to send withdrawal processing DM:', error);
    }
}

// API endpoint to approve withdrawal
app.post('/api/withdrawals/approve', async (req, res) => {
    try {
        const { requestId } = req.body;
        
        const { data: withdrawal, error: withdrawalError } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('id', requestId)
            .single();
        
        if (withdrawalError) throw withdrawalError;
        if (!withdrawal) {
            return res.status(404).json({ success: false, error: 'Withdrawal request not found' });
        }
        
        const paymentData = {
            address: withdrawal.wallet,
            amount: withdrawal.wkc_amount.toString(),
            token: "WKC"
        };
        
        console.log('💰 Processing payment:', paymentData);
        
        const paymentResponse = await fetch('https://bnb-autopayed.onrender.com/api/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(paymentData)
        });
        
        if (!paymentResponse.ok) {
            const errorText = await paymentResponse.text();
            console.error('❌ Payment failed but keeping withdrawal pending:', errorText);
            
            await sendWithdrawalFailureDM(withdrawal.user_id, withdrawal, `Payment processing delayed. Admin will retry shortly.`);
            
            return res.status(400).json({ 
                success: false, 
                error: `Payment failed: ${errorText}. Withdrawal remains pending for retry.` 
            });
        }
        
        const result = await paymentResponse.json();
        
        if (result.success) {
            await supabase
                .from('withdrawals')
                .update({
                    status: 'approved',
                    approved_at: new Date().toISOString(),
                    transaction_hash: result.txHash,
                    explorer_link: result.explorerLink,
                    updated_at: new Date().toISOString()
                })
                .eq('id', requestId);

            await sendWithdrawalSuccessDM(withdrawal.user_id, withdrawal, result);
            
            console.log('✅ Withdrawal approved successfully:', result.txHash);
            
            res.json({
                success: true,
                amount: withdrawal.wkc_amount,
                wallet: withdrawal.wallet,
                txHash: result.txHash,
                explorerLink: result.explorerLink
            });
        } else {
            console.error('❌ Payment API returned failure but keeping withdrawal pending:', result.error);
            
            await sendWithdrawalFailureDM(withdrawal.user_id, withdrawal, `Payment processing delayed. Admin will retry shortly.`);
            
            return res.status(400).json({ 
                success: false, 
                error: result.error || 'Payment failed. Withdrawal remains pending for retry.' 
            });
        }
    } catch (error) {
        console.error('❌ Error approving withdrawal:', error);
        
        try {
            const { data: withdrawal } = await supabase
                .from('withdrawals')
                .select('*')
                .eq('id', requestId)
                .single();
            
            if (withdrawal) {
                await sendWithdrawalFailureDM(withdrawal.user_id, withdrawal, `Payment processing delayed due to technical issue. Admin will retry shortly.`);
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

// API endpoint to reject withdrawal
app.post('/api/withdrawals/reject', async (req, res) => {
    try {
        const { requestId } = req.body;
        
        const { data: withdrawal, error: withdrawalError } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('id', requestId)
            .single();
        
        if (withdrawalError) throw withdrawalError;
        if (!withdrawal) {
            return res.status(404).json({ success: false, error: 'Withdrawal request not found' });
        }
        
        await updateUserBalance(withdrawal.user_id, withdrawal.amount, {
            type: 'withdrawal_refund',
            amount: withdrawal.amount,
            description: 'Withdrawal refund - request rejected'
        });
        
        await supabase
            .from('withdrawals')
            .update({
                status: 'rejected',
                rejected_at: new Date().toISOString(),
                refunded_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', requestId);
        
        res.json({ 
            success: true, 
            message: 'Withdrawal rejected and points refunded',
            refundedAmount: withdrawal.amount
        });
    } catch (error) {
        console.error('Error rejecting withdrawal:', error);
        res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
    }
});

// API endpoint to get pending withdrawals
app.get('/api/withdrawals/pending', async (req, res) => {
    try {
        const { data: withdrawals, error } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('status', 'pending');
        
        if (error) throw error;
        
        res.json({ success: true, withdrawals: withdrawals || [] });
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
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const currentBalance = user.balance || 0;
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
    
    await saveUser(userId.toString(), {
      balance: newBalance
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

// API endpoint to process start parameter
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
    
    if (referrerId === userId.toString()) {
      console.log('❌ Self-referral detected');
      return res.json({ 
        success: true, 
        message: 'Self-referral not allowed' 
      });
    }
    
    const user = await getUser(userId.toString());
    
    if (user && user.referred_by) {
      console.log('❌ User already referred by someone');
      return res.json({ 
        success: true, 
        message: 'Referral already processed' 
      });
    }
    
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
      await saveUser(userId.toString(), {
        referred_by: referrerId,
        referral_processed: true
      });
      
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

// Fix the referral processing endpoint
// Fix the referral processing endpoint
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
    
    // ✅ ALL THE SAME VALIDATION CHECKS
    if (referrerId === referredUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Self-referral not allowed' 
      });
    }
    
    const referredUser = await getUser(referredUserId.toString());
    if (referredUser && referredUser.referred_by) {
      return res.status(400).json({ 
        success: false, 
        error: 'User already has a referrer' 
      });
    }
    
    const referrer = await getUser(referrerId.toString());
    if (!referrer) {
      return res.status(404).json({ 
        success: false, 
        error: 'Referrer not found' 
      });
    }
    
    const referralHistory = referrer.referral_history || [];
    const alreadyReferred = referralHistory.some(ref => 
      ref.referredUserId === referredUserId.toString()
    );
    
    if (alreadyReferred) {
      return res.status(400).json({ 
        success: false, 
        error: 'This user was already referred by you' 
      });
    }
    
    const { data: config, error: configError } = await supabase
      .from('configurations')
      .select('config')
      .eq('id', 'points')
      .single();
    
    const pointsConfig = config ? config.config : {};
    const referralBonus = parseInt(pointsConfig.friendInvitePoints) || 20;
    
    // ✅ ADD REFERRAL BONUS
    await updateUserBalance(referrerId, referralBonus, {
      type: 'referral_bonus',
      amount: referralBonus,
      description: `Referral bonus for inviting user ${referredUserId}`,
      referredUserId: referredUserId,
      timestamp: new Date().toISOString()
    });
    
    // ✅ UPDATE REFERRAL COUNT
    const currentReferrals = referrer.referral_count || 0;
    await saveUser(referrerId.toString(), {
      referral_count: currentReferrals + 1,
      referral_history: [
        ...referralHistory,
        {
          referredUserId: referredUserId,
          bonusAmount: referralBonus,
          timestamp: new Date().toISOString()
        }
      ]
    });
    
    console.log(`✅ Referral processed: ${referrerId} earned ${referralBonus} points`);
    
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

// API endpoint to fix duplicate referrals
app.post('/api/admin/fix-duplicate-referrals', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .not('referred_by', 'is', null);
    
    if (error) throw error;
    
    let fixedCount = 0;
    
    for (const user of users) {
      const referrer = await getUser(user.referred_by);
      if (referrer) {
        const referralHistory = referrer.referral_history || [];
        const userReferred = referralHistory.some(ref => 
          ref.referredUserId === user.id
        );
        
        if (!userReferred) {
          // Add missing referral to history
          await saveUser(user.referred_by, {
            referral_history: [
              ...referralHistory,
              {
                referredUserId: user.id,
                bonusAmount: 10, // Default bonus
                timestamp: user.join_date || new Date().toISOString()
              }
            ]
          });
          fixedCount++;
        }
      }
    }
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} duplicate referrals`,
      fixedCount: fixedCount
    });
    
  } catch (error) {
    console.error('Error fixing duplicate referrals:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fix duplicate referrals' 
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
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const totalInvites = user.referral_count || 0;
    
    const { data: config, error: configError } = await supabase
      .from('configurations')
      .select('config')
      .eq('id', 'points')
      .single();
    
    const pointsConfig = config ? config.config : {};
    const bonusPerFriend = parseInt(pointsConfig.friendInvitePoints) || 20;
    
    const totalEarnings = totalInvites * bonusPerFriend;
    
    res.json({
      success: true,
      stats: {
        totalInvites: totalInvites,
        totalEarnings: totalEarnings,
        bonusPerFriend: bonusPerFriend,
        referralHistory: user.referral_history || []
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

// Team members endpoint
app.get('/api/user/team-members', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing userId parameter' 
    });
  }
  
  try {
    const user = await getUser(userId.toString());
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const referralHistory = user.referral_history || [];
    
    const teamMembers = await Promise.all(
      referralHistory.map(async (referral) => {
        try {
          const referredUser = await getUser(referral.referredUserId.toString());
          if (referredUser) {
            return {
              userId: referral.referredUserId,
              username: referredUser.username || referredUser.first_name,
              joinDate: referredUser.join_date,
              bonusEarned: referral.bonusAmount,
              level: 1
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
    
    if (!address.startsWith('0x') || address.length !== 42) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid BSC address format' 
      });
    }
    
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