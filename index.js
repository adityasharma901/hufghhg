const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); // 🔒 Security
const app = express();

app.use(express.json());
app.use(express.static('public')); 

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const getClientIp = (req) => {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp;
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress;
};

// ==========================================
// 👇 CONFIG (Environment Variables)
const MONGO_URI = process.env.MY_MONGO_URL; 
const API_KEY = process.env.MY_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
// ==========================================

// --- DB CONNECTION ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Website DB Connected (Secure)"))
    .catch(err => console.error("❌ DB Error:", err));

// --- USER MODEL ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    activeOrder: { type: Object, default: null }, // activeOrder.isPaid flag yahan use hoga
    ip: { type: String },
    termsAccepted: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// --- LOG SCHEMA ---
const LogSchema = new mongoose.Schema({
    email: String,
    phone: String,
    server: String,
    status: String,
    otp: String,
    cost: Number,
    ip: String,
    date: { type: Date, default: Date.now }
});
const Log = mongoose.model('Log', LogSchema);

// ==========================================
// 🔒 SECURE ROUTES
// ==========================================

// 1. REGISTER
app.post('/register', async (req, res) => {
    const { email, password, terms } = req.body;
    if (!terms) return res.json({ success: false, message: "Please agree to Terms & Conditions." });

    const strongRegex = /^(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{8,}$/;
    if (!strongRegex.test(password)) return res.json({ success: false, message: "Weak Password! Use 8+ chars, 1 Number, 1 Symbol." });

    try {
        const existing = await User.findOne({ email });
        if (existing) return res.json({ success: false, message: "User already exists" });

        const userIp = getClientIp(req);
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ 
            email, 
            password: hashedPassword,
            ip: userIp,
            termsAccepted: true 
        });
        await newUser.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: "Server Error" }); }
});

// 2. LOGIN (With Recovery Fix)
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.json({ success: false, message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.json({ success: false, message: "Wrong Password" });

        // 🔒 SECURITY CHECK: Fix for Free OTP Glitch (Thief Protection)
        if (user.activeOrder && Date.now() > user.activeOrder.expiry) {
            try {
                const checkApi = `https://5sim.net/v1/user/check/${user.activeOrder.id}`;
                const resp = await axios.get(checkApi, { headers: { 'Authorization': 'Bearer ' + API_KEY } });
                
                const realOtps = resp.data.sms ? resp.data.sms.map(s => s.code) : [];
                const dbOtps = user.activeOrder.otps || [];

                // Agar 5SIM ke paas OTP hai, par humare DB me paisa nahi kata
                if (realOtps.length > 0 && dbOtps.length === 0) {
                    console.log(`🚨 THIEF CAUGHT! Recovering money from: ${user.email}`);
                    const server = user.activeOrder.server;
                    const cost = (server === 'pl' || server === 'hk') ? 15 : 8;

                    user.balance -= cost; 
                    
                    await new Log({
                        email: user.email,
                        phone: user.activeOrder.phone,
                        server: server,
                        status: 'SUCCESS',
                        otp: realOtps.join(', '),
                        cost: cost,
                        ip: 'Auto-Recovery-System'
                    }).save();
                }
            } catch (err) { console.log("Recovery Check Failed"); }

            user.activeOrder = null; 
            await user.save();
        }
        
        res.json({ success: true, balance: user.balance, activeOrder: user.activeOrder });
    } catch (e) { res.json({ success: false, message: "Login Error" }); }
});

// 3. GET BALANCE
app.post('/get-balance', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        res.json({ balance: user ? user.balance : 0, activeOrder: user ? user.activeOrder : null });
    } catch (e) { res.json({ balance: 0 }); }
});

// 4. BUY NUMBER (With Recovery Fix)
app.post('/buy-number', async (req, res) => {
    const { email, server } = req.body; 
    const user = await User.findOne({ email });
    if (!user) return res.json({ success: false, message: "Login again" });

    // 🔒 SECURITY CHECK START
    if (user.activeOrder) {
        if (Date.now() > user.activeOrder.expiry) {
            try {
                const checkApi = `https://5sim.net/v1/user/check/${user.activeOrder.id}`;
                const resp = await axios.get(checkApi, { headers: { 'Authorization': 'Bearer ' + API_KEY } });
                
                const realOtps = resp.data.sms ? resp.data.sms.map(s => s.code) : [];
                const dbOtps = user.activeOrder.otps || [];

                if (realOtps.length > 0 && dbOtps.length === 0) {
                    console.log(`🚨 THIEF CAUGHT! Recovering money inside Buy Route`);
                    const server = user.activeOrder.server;
                    const cost = (server === 'pl' || server === 'hk') ? 15 : 8;
                    
                    user.balance -= cost; 

                    await new Log({
                        email: user.email,
                        phone: user.activeOrder.phone,
                        server: server,
                        status: 'SUCCESS',
                        otp: realOtps.join(', '),
                        cost: cost,
                        ip: 'Auto-Recovery-System'
                    }).save();
                }
            } catch (err) { console.log("Recovery Check Failed"); }

            user.activeOrder = null; 
            await user.save();
        }
        else return res.json({ success: false, message: "Finish current order first!" });
    }
    // 🔒 SECURITY CHECK END

    let apiUrl = '', requiredBalance = 0;
    if(server === 'uk') { apiUrl = 'https://5sim.net/v1/user/buy/activation/england/virtual51/microsoft'; requiredBalance = 8; }
    else if (server === 'nl') { apiUrl = 'https://5sim.net/v1/user/buy/activation/netherlands/virtual58/microsoft'; requiredBalance = 8; }
    else if (server === 'pl') { apiUrl = 'https://5sim.net/v1/user/buy/activation/poland/virtual58/microsoft'; requiredBalance = 15; }
    else if (server === 'hk') { apiUrl = 'https://5sim.net/v1/user/buy/activation/hongkong/virtual54/microsoft'; requiredBalance = 15; }
    else return res.json({ success: false, message: "Invalid Server" });

    if (user.balance < requiredBalance) return res.json({ success: false, message: `Low Balance! Need ₹${requiredBalance}` });

    try {
        const response = await axios.get(apiUrl, { headers: { 'Authorization': 'Bearer ' + API_KEY } });
        if (!response.data || !response.data.id) throw new Error("No Stock");

        const orderData = { id: response.data.id, phone: response.data.phone, server: server, expiry: Date.now() + 180000, otps: [], isPaid: false };
        user.activeOrder = orderData;
        await user.save();
        res.json({ success: true, data: response.data, orderDetails: orderData });
    } catch (error) { res.json({ success: false, message: "Stock Not Available" }); }
});

// ==========================================
// 🔥 CHECK OTP (Smart & Secure)
// ==========================================
app.get('/check-otp', async (req, res) => {
    const { id, email } = req.query;
    try {
        const response = await axios.get(`https://5sim.net/v1/user/check/${id}`, { headers: { 'Authorization': 'Bearer ' + API_KEY } });
        const orderData = response.data;
        const smsList = orderData.sms ? orderData.sms.map(s => s.code) : [];
        
        const user = await User.findOne({ email });
        if (!user) return res.json({ status: 'ERROR' });

        // 🔒 SECURITY FIX: Agar Active Order nahi hai ya ID match nahi karti -> OTP mat dikhao!
        if (!user.activeOrder || user.activeOrder.id != id) {
            return res.json({ status: 'CANCELED', sms: [] });
        }

        // 🔥 FIX: Check Payment Status from DB (Not RAM)
        if (smsList.length > 0 && user.activeOrder && !user.activeOrder.isPaid) {
            
            let deductionAmount = (user.activeOrder.server === 'pl' || user.activeOrder.server === 'hk') ? 15 : 8;
            
            user.balance -= deductionAmount;
            user.activeOrder.isPaid = true; 
            user.markModified('activeOrder');
            
            await user.save();
            console.log(`💰 Deducted ₹${deductionAmount} for ${email} (OTP Received)`);
        }

        // Expiry & OTP Update
        if (user.activeOrder) {
            if (smsList.length > 0 && user.activeOrder.otps.length === 0) {
                user.activeOrder.expiry = Date.now() + 600000;
                user.activeOrder.otps = smsList; 
                user.markModified('activeOrder');
                await user.save();
            }
            else if (smsList.length !== user.activeOrder.otps.length) {
                user.activeOrder.otps = smsList;
                user.markModified('activeOrder');
                await user.save(); 
            }

            // Logging Logic
            if (['FINISHED', 'TIMEOUT', 'CANCELED'].includes(orderData.status)) {
                const existingLog = await Log.findOne({ phone: user.activeOrder.phone });
                if (!existingLog) {
                    const finalStatus = (smsList.length > 0) ? 'SUCCESS' : 'CANCELLED';
                    const finalOtp = (smsList.length > 0) ? smsList.join(', ') : 'No OTP';
                    const finalCost = (finalStatus === 'SUCCESS') ? (user.activeOrder.isPaid ? ((user.activeOrder.server === 'pl' || user.activeOrder.server === 'hk') ? 15 : 8) : 0) : 0; 
                    const currentIp = getClientIp(req); 

                    await new Log({
                        email: user.email,
                        phone: user.activeOrder.phone,
                        server: user.activeOrder.server,
                        status: finalStatus,
                        otp: finalOtp,
                        cost: finalCost,
                        ip: currentIp
                    }).save();
                }
            }
        }
        res.json({ status: orderData.status, sms: smsList, expiry: user?.activeOrder?.expiry });
    } catch (error) { 
        console.log(error.message);
        res.json({ status: 'ERROR', sms: [] }); 
    }
});

// CANCEL ORDER (Fixed: Don't cancel if OTP exists)
app.get('/cancel-order', async (req, res) => {
    const { id, email } = req.query;
    try {
        // Pehle 5SIM se try karo. Agar OTP aa chuka hoga to ye line ERROR degi aur CATCH me bhej degi.
        await axios.get(`https://5sim.net/v1/user/ban/${id}`, { headers: { 'Authorization': 'Bearer ' + API_KEY } });
        
        // Agar 5SIM ne allow kiya (Koi error nahi aaya), tabhi local DB se hatao
        const user = await User.findOne({ email });
        if (user && user.activeOrder) {
            // Check duplicate log
            const existingLog = await Log.findOne({ phone: user.activeOrder.phone });
            if (!existingLog) {
                const currentIp = getClientIp(req);
                await new Log({
                    email: user.email, phone: user.activeOrder.phone, server: user.activeOrder.server,
                    status: 'CANCELLED', otp: 'User Cancelled', cost: 0, ip: currentIp
                }).save();
            }

            user.activeOrder = null;
            await user.save();
        }
        res.json({ success: true });

    } catch (e) {
        // Agar 5SIM ne error diya (matlab OTP aa chuka hai ya ban nahi ho sakta)
        // To hum bhi cancel nahi karenge!
        console.log("Cancel Failed at 5SIM (OTP might be received):", e.message);
        res.json({ success: false, message: "Cannot cancel! OTP might be received." });
    }
});

// FINISH ORDER (Manual Complete)
app.get('/finish-order', async (req, res) => {
    const { id, email } = req.query;
    try { await axios.get(`https://5sim.net/v1/user/finish/${id}`, { headers: { 'Authorization': 'Bearer ' + API_KEY } }); } catch (e) { }
    
    const user = await User.findOne({ email });
    if (user && user.activeOrder) {
        const otps = user.activeOrder.otps || [];
        
        // Check duplicate log
        const existingLog = await Log.findOne({ phone: user.activeOrder.phone });
        if (!existingLog) {
            const currentIp = getClientIp(req);
            await new Log({
                email: user.email, 
                phone: user.activeOrder.phone, 
                server: user.activeOrder.server,
                status: 'SUCCESS', 
                otp: otps.join(', '), 
                cost: 8, 
                ip: currentIp
            }).save();
        }

        user.activeOrder = null; 
        await user.save();
    }
    res.json({ success: true });
});

// ADMIN ROUTES
app.get('/admin-add', async (req, res) => {
    const { email, amount, key } = req.query;
    if (key !== ADMIN_KEY) return res.send("❌ Access Denied!");
    try {
        const updatedUser = await User.findOneAndUpdate({ email: email }, { $inc: { balance: Number(amount) } }, { new: true });
        if (!updatedUser) return res.send("❌ User Not Found");
        res.send(`✅ Added ${amount} to ${email}. New Balance: ${updatedUser.balance}`);
    } catch (e) { res.send("Error: " + e.message); }
});

app.get('/admin/total-funds', async (req, res) => {
    const { key } = req.query;
    if (key !== ADMIN_KEY) return res.json({ success: false });
    try {
        const stats = await User.aggregate([{ $group: { _id: null, totalMoney: { $sum: "$balance" }, totalUsers: { $sum: 1 } } }]);
        res.json({ success: true, totalMoney: stats[0]?.totalMoney || 0, totalUsers: stats[0]?.totalUsers || 0 });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/delete-user', async (req, res) => {
    const { email, key } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false });
    try {
        const deletedUser = await User.findOneAndDelete({ email: email });
        res.json({ success: true, message: "User Deleted", oldBalance: deletedUser?.balance });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/history/user', async (req, res) => {
    const { email, key } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false });
    try {
        const logs = await Log.find({ email: email }).sort({ date: -1 }).limit(50);
        res.json({ success: true, logs });
    } catch (e) { res.json({ success: false }); }
});

app.post('/admin/history/number', async (req, res) => {
    const { phone, key } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false });
    try {
        const logs = await Log.find({ phone: { $regex: phone } }); 
        res.json({ success: true, logs });
    } catch (e) { res.json({ success: false }); }
});

// USER HISTORY ROUTE
app.post('/get-history', async (req, res) => {
    const { email } = req.body;
    try {
        const logs = await Log.find({ email: email }).sort({ date: -1 }).limit(50);
        res.json({ success: true, logs });
    } catch (e) { res.json({ success: false, message: "Error fetching history" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Website running on port ${PORT}`));
