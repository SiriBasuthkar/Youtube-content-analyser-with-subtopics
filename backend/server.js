import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Groq AI configuration
const GROQ_API_KEY = process.env.GORQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// YouTube API key
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Helper: extract YouTube video ID
function extractVideoId(url) {
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[7].length === 11) ? match[7] : null;
}

// Helper: get video data
async function getYouTubeVideoData(videoId) {
  const response = await axios.get(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`
  );
  if (!response.data.items || response.data.items.length === 0)
    throw new Error('Video not found');

  const snippet = response.data.items[0].snippet;
  return {
    title: snippet.title,
    description: snippet.description,
    channelTitle: snippet.channelTitle,
    publishedAt: snippet.publishedAt,
    thumbnail: snippet.thumbnails.default.url
  };
}

// Helper: get transcript or fallback to description
async function getTranscript(videoId) {
  try {
    const response = await axios.get(`https://youtube-transcriptor.vercel.app/transcript?videoId=${videoId}`);
    if (response.data && response.data.transcript) return response.data.transcript;
    throw new Error('Transcript not available');
  } catch {
    const videoData = await getYouTubeVideoData(videoId);
    return videoData.description || "No transcript available.";
  }
}

// Generic Groq AI call
async function callGroq(messages, max_tokens = 1000) {
  const response = await axios.post(
    GROQ_API_URL,
    { model: GROQ_MODEL, messages, max_tokens },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return response.data.choices[0].message.content.trim();
}

// Analyze coverage based on user-provided subtopics
async function analyzeCoverage(transcript, subtopics, topic) {
  try {
    const truncatedTranscript = transcript.length > 4000
      ? transcript.substring(0, 4000) + "... [truncated]"
      : transcript;

    const prompt = `You are an educational analyst. 
For each subtopic listed below, provide a coverage percentage (0-100) and a short explanation based on the transcript. 
Format each subtopic like this:
Subtopic: <name>
Score: <0-100>
Evidence: <brief explanation>

Transcript: "${truncatedTranscript}"

Subtopics: ${subtopics.join(', ')}`;

    const messages = [
      { role: 'system', content: 'You are an educational content analyst.' },
      { role: 'user', content: prompt }
    ];

    const responseText = await callGroq(messages, 2000);

    // Parse response manually
    const subtopicAnalysis = subtopics.map(sub => {
      const regex = new RegExp(`${sub}[\\s\\S]*?Score:\\s*(\\d+)`, 'i');
      const match = responseText.match(regex);
      return {
        subtopic: sub,
        coverageScore: match ? parseInt(match[1]) : 0,
        covered: match ? parseInt(match[1]) >= 50 : false,
        evidence: match ? "Evidence found in transcript." : "No evidence found."
      };
    });

    const overallScore = Math.round(
      subtopicAnalysis.reduce((sum, s) => sum + s.coverageScore, 0) / subtopicAnalysis.length
    );

    return {
      overallScore,
      subtopicAnalysis,
      summary: `Overall coverage based on ${subtopics.length} subtopics.`
    };
  } catch (err) {
    console.error('Coverage analysis error:', err.message);
    return {
      overallScore: 0,
      subtopicAnalysis: subtopics.map(sub => ({
        subtopic: sub,
        coverageScore: 0,
        covered: false,
        evidence: "Failed to analyze coverage."
      })),
      summary: "Failed to generate coverage analysis."
    };
  }
}

// API endpoint
app.post('/api/analyze', async (req, res) => {
  try {
    const { youtubeUrl, topic, customSubtopics } = req.body;

    if (!youtubeUrl || !topic || !customSubtopics || customSubtopics.length === 0) {
      return res.status(400).json({ error: 'YouTube URL, topic, and at least one subtopic are required.' });
    }

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL.' });

    const videoData = await getYouTubeVideoData(videoId);
    const transcript = await getTranscript(videoId);

    const analysis = await analyzeCoverage(transcript, customSubtopics, topic);

    res.json({
      success: true,
      videoInfo: {
        videoId,
        title: videoData.title,
        channelTitle: videoData.channelTitle,
        publishedAt: videoData.publishedAt,
        thumbnail: videoData.thumbnail,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`
      },
      transcript: transcript.substring(0, 500) + (transcript.length > 500 ? '...' : ''),
      subtopics: customSubtopics,
      analysis
    });

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message, details: 'Please check API keys and try again.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Server running',
    hasGroqKey: !!GROQ_API_KEY,
    hasYouTubeKey: !!YOUTUBE_API_KEY
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Groq key configured: ${!!GROQ_API_KEY}`);
  console.log(`YouTube API key configured: ${!!YOUTUBE_API_KEY}`);
});
