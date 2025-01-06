require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const User = require('./models/User');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const port = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Middleware setup
app.use(session({
    secret: process.env.SESSION_SECRET || '29FAA',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Database Connection
const mongoUri = process.env.MONGO_URI;
mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
    .then(() => console.log('Connected to Database'))
    .catch(err => console.log('Error connecting to Database:', err));

// Nodemailer Setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    }
});

// Generate OTP and Manage Timer
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

let currentOTP;
let tempUserData;
let otpTimestamp;
const otpExpiryTime = 30 * 1000; // 30 seconds

// Routes
app.get("/", (req, res) => res.render("welcome"));

app.get("/login", (req, res) => res.render("login"));

app.post("/login", async (req, res) => {
    const { uname, psw } = req.body;
    try {
        const user = await User.findOne({ email: uname });
        if (user) {
            console.log(`User found. Stored password hash: ${user.password}`);

            // Trim any extra whitespace before comparing the password
            const passwordMatch = await bcrypt.compare(psw.trim(), user.password);

            console.log(`Password comparison result: ${passwordMatch}`);

            if (passwordMatch) {
                // Generate JWT token
                const token = jwt.sign({ id: user._id, name: user.name }, process.env.JWT_SECRET, { expiresIn: '1h' });
                res.cookie('token', token, { httpOnly: true });
                req.session.user = user;
                return res.redirect("/room");  // Redirect to room after login
            } else {
                console.error(`Login failed: Incorrect password for user ${uname}`);
                return res.redirect("/login?error=invalid_credentials");
            }
        } else {
            console.error(`Login failed: User not found with email ${uname}`);
            return res.redirect("/login?error=invalid_credentials");
        }
    } catch (error) {
        console.error("Error during login:", error);
        return res.redirect("/login?error=server_error");
    }
});


function authenticateToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) {
        return res.redirect('/login');
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.redirect('/login');
        }
        req.user = user;
        next();
    });
}

// Lobby page
app.get("/lobby", authenticateToken, (req, res) => {
    res.render("lobby");
});

// Room page
app.get("/room", authenticateToken, (req, res) => {
    res.render("room", { username: req.user.name });
});

// Registration (GET and POST routes)
app.get("/register", (req, res) => {
    res.render("register");  // Render registration form
});

app.post("/register", async (req, res) => {
    const { name, email, password, phone } = req.body;
    currentOTP = generateOTP();
    otpTimestamp = new Date().getTime();
    tempUserData = { name, email, password, phone };

    if (!name || !email || !password || !phone) {
        return res.redirect('/register?error=missing_fields');
    }

    try {
        const existingUser = await User.findOne({ email: email });
        if (existingUser) {
            console.error(`Email already registered: ${email}`);
            return res.redirect('/register?error=email_exists');
        }

        const mailOptions = {
            from: `Team Echo <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Verification',
            text: `Thanks for considering EchoCall, your OTP is: ${currentOTP}`
        };

        await transporter.sendMail(mailOptions);
        res.render("otp");
    } catch (error) {
        console.error("Error during registration:", error);
        res.redirect('/register?error=failed_to_send_email');
    }
});

// Verify OTP
app.post("/verify", async (req, res) => {
    const { otp } = req.body;
    if (otp === currentOTP) {
        try {
            const hashedPassword = await bcrypt.hash(tempUserData.password, 10);
            const newUser = new User({
                name: tempUserData.name,
                email: tempUserData.email,
                password: hashedPassword,  // Store hashed password
                phone: tempUserData.phone
            });

            await newUser.save();
            res.redirect("/login");
        } catch (error) {
            console.error("Error saving user:", error);
            res.redirect('/register?error=failed_to_save_user');
        }
    } else {
        res.render("otp", { error: "Incorrect OTP" });
    }
});

// Resend OTP
app.post("/resend-otp", async (req, res) => {
    const currentTime = new Date().getTime();
    if (otpTimestamp && currentTime - otpTimestamp < otpExpiryTime) {
        return res.status(429).send("Wait before resending OTP.");
    }

    currentOTP = generateOTP();
    otpTimestamp = currentTime;

    const mailOptions = {
        from: `Team Echo <${process.env.EMAIL_USER}>`,
        to: tempUserData.email,
        subject: "Resend OTP Verification",
        text: `Your new OTP is: ${currentOTP}`,
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).send("OTP resent successfully.");
    } catch (error) {
        console.error("Error resending OTP:", error);
        res.status(500).send("Failed to resend OTP.");
    }
});

// WebSocket Handling
server.on('upgrade', (request, socket, head) => {
    const cookies = request.headers.cookie || '';
    const token = cookies.split('; ').find(row => row.startsWith('token='))?.split('=')[1];

    if (token) {
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) {
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.username = user.name || 'Unknown';

                ws.on('message', (message) => {
                    if (Buffer.isBuffer(message)) {
                        message = message.toString();
                    }

                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ username: ws.username, text: message }));
                        }
                    });
                });

                ws.on('close', () => {
                    console.log('Client disconnected:', ws.username);
                });
            });
        });
    } else {
        socket.destroy();
    }
});

// Error Handling
app.use((err, req, res, next) => {
    console.error("Unexpected error:", err.stack);
    res.status(500).send('Something broke!');
});

// Starting the server
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`Server is accessible on http://localhost:${port}`);
});
