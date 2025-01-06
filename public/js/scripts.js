// Handle OTP Resend Timer
let timer = 30;
const timerElement = document.getElementById("timer");
const resendButton = document.getElementById("resendOtp");

function startTimer() {
    resendButton.disabled = true;
    timer = 30;
    const interval = setInterval(() => {
        timer--;
        timerElement.textContent = `You can resend OTP in ${timer}s`;
        if (timer <= 0) {
            clearInterval(interval);
            resendButton.disabled = false;
            timerElement.textContent = "";
        }
    }, 1000);
}

function resendOtp() {
    fetch("/resend-otp", { method: "POST" })
        .then(response => response.text())
        .then(data => {
            alert(data);
            startTimer();
        })
        .catch(err => console.error("Error resending OTP:", err));
}

// Start Timer on Load
if (resendButton) {
    startTimer();
}

// WebSocket Chat Functionality
let socket;

function sendMessage() {
    const messageInput = document.getElementById("message");
    if (!messageInput.value.trim()) return;

    socket.send(messageInput.value);
    messageInput.value = "";
}

if (window.location.pathname === "/room") {
    socket = new WebSocket(`ws://${window.location.host}`);

    socket.onmessage = (event) => {
        const { username, text } = JSON.parse(event.data);
        const chatbox = document.getElementById("chatbox");
        const messageElement = document.createElement("div");
        messageElement.textContent = `${username}: ${text}`;
        chatbox.appendChild(messageElement);
    };
}
