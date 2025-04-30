const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");
const xlsx = require("xlsx");
const { MongoClient } = require("mongodb");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const port = 5000;

// Create HTTP server and attach WebSocket
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB Connection
const uri = process.env.MONGO_URI ;
const client = new MongoClient(uri);
const dbName = "Results";
const collectionName = "StudentResults";

// Configure Multer for file uploads
const upload = multer({ dest: "uploads/" });

// Helper Function to Process CSV Files
const processCSV = async (filePath) => {
  const jsonData = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // Validate required fields
        if (row.rollNumber && row.SUBCODE && row.SUBNAME) {
          jsonData.push(row);
        }
      })
      .on("end", resolve)
      .on("error", reject);
  });
  return jsonData;
};

// Helper Function to Process Excel Files
const processExcel = (filePath) => {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
};

// WebSocket connection for progress tracking
io.on("connection", (socket) => {
  console.log("Client connected for progress updates");
});

// Admin Endpoint to Upload and Replace Data
app.post("/admin/upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;

  try {
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    let jsonData = [];
    const fileExtension = req.file.originalname.split(".").pop().toLowerCase();

    // Parse file based on its type
    if (fileExtension === "csv") {
      jsonData = await processCSV(filePath);
    } else if (["xlsx", "xls"].includes(fileExtension)) {
      jsonData = processExcel(filePath);
    } else {
      throw new Error("Unsupported file format. Only CSV, XLSX, and XLS are allowed.");
    }

    // Notify client that upload started
    io.emit("uploadProgress", { progress: 0 });

    // Clear existing data
    await collection.deleteMany({});

    // Insert new data with progress updates
    const batchSize = 10;
    let insertedCount = 0;
    for (let i = 0; i < jsonData.length; i += batchSize) {
      await collection.insertMany(jsonData.slice(i, i + batchSize));
      insertedCount += batchSize;
      let progress = Math.min(100, Math.round((insertedCount / jsonData.length) * 100));
      io.emit("uploadProgress", { progress });
    }

    // Cleanup uploaded file
    fs.unlinkSync(filePath);

    io.emit("uploadProgress", { progress: 100 });

    res.status(200).json({ message: "New data uploaded successfully, and existing data replaced!" });
  } catch (error) {
    console.error("Error during file upload:", error);

    // Cleanup file in case of error
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    io.emit("uploadProgress", { progress: -1 }); // Notify error
    res.status(500).json({ message: "Failed to process the uploaded file. " + error.message });
  }
});

// Endpoint to Query Results by Roll Number
app.get("/results/:rollNumber", async (req, res) => {
  try {
    const rollNumber = req.params.rollNumber;
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // Query the database
    const result = await collection.findOne({ rollNumber });

    if (result) {
      res.status(200).json(result);
    } else {
      res.status(404).json({ message: "Result not found for this roll number." });
    }
  } catch (error) {
    console.error("Error fetching result:", error);
    res.status(500).json({ message: "Failed to fetch result." });
  }
});

// Ensure Roll Number Indexing for Performance
client.connect().then(async () => {
  const db = client.db(dbName);
  const collection = db.collection(collectionName);

  // Create an index on the rollNumber field
  await collection.createIndex({ rollNumber: 1 });

  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
});
