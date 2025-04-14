const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const cors = require("cors")
const fs = require("fs")
const path = require("path")

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "DELETE"],
  },
})

// Path to store chat messages
const CHAT_STORAGE_PATH = path.join(__dirname, "chat_storage")
const CLASS_REQUESTS_PATH = path.join(__dirname, "class_requests.json")

// Create storage directory if it doesn't exist
if (!fs.existsSync(CHAT_STORAGE_PATH)) {
  fs.mkdirSync(CHAT_STORAGE_PATH, { recursive: true })
}

// Initialize class requests storage if it doesn't exist
if (!fs.existsSync(CLASS_REQUESTS_PATH)) {
  fs.writeFileSync(CLASS_REQUESTS_PATH, JSON.stringify({}), "utf8")
}

// Helper function to get chat file path for a room
const getChatFilePath = (room) => path.join(CHAT_STORAGE_PATH, `${room}.json`)

// Helper function to load chat history
const loadChatHistory = (room) => {
  const filePath = getChatFilePath(room)
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, "utf8")
    return JSON.parse(data)
  }
  return []
}

// Helper function to save chat history
const saveChatHistory = (room, messages) => {
  const filePath = getChatFilePath(room)
  fs.writeFileSync(filePath, JSON.stringify(messages), "utf8")
}

// Helper function to save chat message
const saveChatMessage = (room, message) => {
  const filePath = getChatFilePath(room)
  const history = loadChatHistory(room)
  history.push(message)
  fs.writeFileSync(filePath, JSON.stringify(history), "utf8")
}

// Helper function to load class requests
const loadClassRequests = () => {
  if (fs.existsSync(CLASS_REQUESTS_PATH)) {
    const data = fs.readFileSync(CLASS_REQUESTS_PATH, "utf8")
    return JSON.parse(data)
  }
  return {}
}

// Helper function to save class requests
const saveClassRequests = (requests) => {
  fs.writeFileSync(CLASS_REQUESTS_PATH, JSON.stringify(requests), "utf8")
}

// API endpoint to get chat history
app.get("/api/chat/:room", (req, res) => {
  const { room } = req.params
  const history = loadChatHistory(room)
  res.json(history)
})

// API endpoint to delete a message
app.delete("/api/chat/:room/:messageId", (req, res) => {
  const { room, messageId } = req.params
  const { author } = req.query

  const history = loadChatHistory(room)
  const updatedHistory = history.filter((msg) => {
    // Keep messages that don't match the ID or weren't sent by the author
    return msg.id !== messageId || msg.author !== author
  })

  // If no messages were removed, return 403 (Forbidden)
  if (history.length === updatedHistory.length) {
    return res.status(403).json({ error: "You can only delete your own messages" })
  }

  saveChatHistory(room, updatedHistory)

  // Broadcast the deletion to all clients in the room
  io.to(room).emit("message_deleted", { messageId })

  res.status(200).json({ success: true })
})

// API endpoint to create a class request
app.post("/api/class-request", (req, res) => {
  const requestData = req.body
  const requests = loadClassRequests()

  // Generate a unique ID for the request
  const requestId = Date.now().toString()
  requestData.id = requestId
  requestData.participants = [
    {
      studentId: requestData.creatorStudentId,
      fullName: requestData.creatorName,
      class: requestData.creatorClass,
    },
  ]
  requestData.participantCount = 1
  requestData.createdAt = new Date().toISOString()

  // Save the request
  requests[requestId] = requestData
  saveClassRequests(requests)

  // Broadcast to all clients in the room
  io.to(requestData.room).emit("class_request_created", requestData)

  res.status(201).json(requestData)
})

// API endpoint to delete a class request
app.delete("/api/class-request/:id", (req, res) => {
  const { id } = req.params
  const { creator } = req.query
  const requests = loadClassRequests()

  if (!requests[id]) {
    return res.status(404).json({ error: "Class request not found" })
  }

  // Check if the user is the creator of the request
  if (requests[id].creatorName !== creator) {
    return res.status(403).json({ error: "You can only delete your own class requests" })
  }

  // Get the room before deleting
  const room = requests[id].room

  // Delete the request
  delete requests[id]
  saveClassRequests(requests)

  // Broadcast to all clients in the room
  io.to(room).emit("class_request_deleted", { id })

  res.status(200).json({ success: true })
})

// API endpoint to join a class request
app.post("/api/class-request/:id/join", (req, res) => {
  const { id } = req.params
  const participantData = req.body
  const requests = loadClassRequests()

  if (!requests[id]) {
    return res.status(404).json({ error: "Class request not found" })
  }

  // Check if student already joined
  const alreadyJoined = requests[id].participants.some((p) => p.studentId === participantData.studentId)

  if (alreadyJoined) {
    return res.status(400).json({ error: "You have already joined this class request" })
  }

  // Add participant
  requests[id].participants.push(participantData)
  requests[id].participantCount = requests[id].participants.length

  // Save updated requests
  saveClassRequests(requests)

  // Broadcast to all clients in the room
  io.to(requests[id].room).emit("class_request_updated", requests[id])

  res.status(200).json(requests[id])
})

// API endpoint to get all class requests for a room
app.get("/api/class-requests/:room", (req, res) => {
  const { room } = req.params
  const requests = loadClassRequests()

  // Filter requests by room
  const roomRequests = Object.values(requests).filter((req) => req.room === room)

  res.json(roomRequests)
})

// API endpoint to get participants for a class request
app.get("/api/class-request/:id/participants", (req, res) => {
  const { id } = req.params
  const requests = loadClassRequests()

  if (!requests[id]) {
    return res.status(404).json({ error: "Class request not found" })
  }

  res.json(requests[id].participants)
})

app.get("/", (req, res) => {
  res.send("Chat server is running")
})

// Keep track of active users in rooms
const activeRooms = {}

io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id)

  socket.on("join_room", (room) => {
    // Join the socket to the specified room
    socket.join(room)

    // Keep track of the room this socket is in
    socket.currentRoom = room

    if (!activeRooms[room]) {
      activeRooms[room] = new Set()
    }
    activeRooms[room].add(socket.id)

    // Send chat history to the user
    const history = loadChatHistory(room)
    socket.emit("chat_history", history)

    console.log(`User ${socket.id} joined room: ${room}`)
    console.log(`Active users in room ${room}:`, activeRooms[room].size)
  })

  socket.on("send_message", (data) => {
    console.log("Message received:", data)

    // Add a unique ID to the message
    data.id = Date.now().toString() + Math.random().toString(36).substr(2, 5)

    // Save the message to storage
    saveChatMessage(data.room, data)

    // Send to all clients in the room EXCEPT the sender
    socket.to(data.room).emit("receive_message", data)

    // Send back to the sender with the generated ID
    socket.emit("message_sent", data)
  })

  socket.on("disconnect", () => {
    console.log("🔴 User disconnected:", socket.id)

    // Remove user from active rooms
    if (socket.currentRoom && activeRooms[socket.currentRoom]) {
      activeRooms[socket.currentRoom].delete(socket.id)

      // Clean up empty rooms
      if (activeRooms[socket.currentRoom].size === 0) {
        delete activeRooms[socket.currentRoom]
      }
    }
  })
})

const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
