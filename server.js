const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// 1. Connect to the Supabase Database using hidden Railway variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// The Buffer Memory
const messageBuffer = new Map();

// 2. The Dynamic Router (Listens for /api/shield/USER_ID)
app.post('/api/shield/:shield_id', async (req, res) => {
    // Instantly satisfy Meta's strict timeout rule
    res.status(200).send('OK');

    const shieldId = req.params.shield_id;
    const incomingData = req.body;

    // 3. Look up where this specific user's messages should go
    const { data, error } = await supabase
        .from('users')
        .select('destination_url')
        .eq('shield_id', shieldId)
        .single();

    // If the URL isn't in your database, block it for security
    if (error || !data) {
        console.log(`Blocked: Unregistered shield ID - ${shieldId}`);
        return;
    }

    const destinationUrl = data.destination_url;

    // 4. The Anti-Spam 5-Second Buffer
    if (!messageBuffer.has(shieldId)) {
        messageBuffer.set(shieldId, {
            messages: [],
            timer: null
        });
    }

    const userBuffer = messageBuffer.get(shieldId);
    userBuffer.messages.push(incomingData);

    // Reset the timer if they spam another message quickly
    if (userBuffer.timer) {
        clearTimeout(userBuffer.timer);
    }

    // Start the final 5-second countdown before firing to the AI
    userBuffer.timer = setTimeout(async () => {
        const bundledPayload = {
            shield_id: shieldId,
            batched_messages: userBuffer.messages
        };

        try {
            // Forward the clean, bundled data to their webhook
            await fetch(destinationUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bundledPayload)
            });
            console.log(`Success: Forwarded bundle to ${shieldId}'s AI.`);
        } catch (err) {
            console.error(`Failed to forward for ${shieldId}:`, err);
        }

        // Clear the buffer so it's ready for the next conversation
        messageBuffer.delete(shieldId);
    }, 5000);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`NodeShield Multi-Player Engine is live on port ${PORT}`);
});
