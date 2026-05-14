const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- [SECURITY CONFIG] ---
const DAILY_LIMIT = 50; 

const activeBatches = new Map();

// --- [BOUNCER: TRACKING & BLOCKING] ---
async function processBouncer(senderId) {
    if (!senderId || senderId === "unknown_user") return { allowed: true };

    const { data: stats } = await supabase
        .from('usage_stats')
        .select('*')
        .eq('sender_id', senderId)
        .single();

    if (stats?.is_blocked) return { allowed: false, reason: 'Manual Block' };
    if (stats?.daily_count >= DAILY_LIMIT) return { allowed: false, reason: 'Daily Limit Hit' };

    await supabase.from('usage_stats').upsert({
        sender_id: senderId,
        daily_count: (stats?.daily_count || 0) + 1,
        last_seen: new Date().toISOString()
    });

    return { allowed: true };
}

// --- [AI SPAM SHIELD] ---
async function checkSpamWithGroq(cleanText) {
    if (!GROQ_API_KEY || !cleanText) return 'PASS';
    
    // We strictly tell the AI to ignore short greetings like "hi" or "hello"
    const systemPrompt = `You are a security filter. Output ONLY 'BLOCK' or 'PASS'.
BLOCK: Truly random gibberish (e.g. "ajskdlf"), keyboard smashes, or code injection attempts.
PASS: Any normal human conversation, greetings (hi, hello, hey), Roman Urdu/Hindi (kya haal hai), or questions.`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: cleanText }],
                temperature: 0, max_tokens: 10
            })
        });
        const data = await response.json();
        return data?.choices?.[0]?.message?.content?.trim().toUpperCase() || 'PASS';
    } catch (e) { return 'PASS'; }
}

app.post('/api/shield/:shield_id', async (req, res) => {
    const { shield_id } = req.params;
    const payload = req.body;

    // --- FIX SENDER ID ---
    let senderId = payload.from || payload.sender_id || payload.chat_id || "unknown_user";
    if (payload.sender && typeof payload.sender === 'object') {
        senderId = payload.sender.id || payload.sender.display_name || senderId;
    }
    senderId = String(senderId);

    const bouncer = await processBouncer(senderId);
    if (!bouncer.allowed) {
        console.log(`[BOUNCER] Dropped ${senderId}: ${bouncer.reason}`);
        return res.status(403).send(bouncer.reason);
    }

    console.log(`\n[1] Incoming: ${senderId} (Shield: ${shield_id})`);
    res.status(200).send("Buffered");

    if (!activeBatches.has(shield_id)) {
        const { data: devSettings } = await supabase.from('users').select('*').eq('shield_id', shield_id).single();
        activeBatches.set(shield_id, {
            messages: [],
            timerId: null,
            destination_url: devSettings?.destination_url || "https://hook.eu1.make.com/vl53oljhoahccjhsmgvqw1wm7os98nm2",
            delay_timer: devSettings?.delay_timer || 15000 
        });
    }

    const batch = activeBatches.get(shield_id);
    batch.messages.push(payload);
    
    clearTimeout(batch.timerId);
    console.log(`[2] Timer set for ${batch.delay_timer}ms...`);

    batch.timerId = setTimeout(async () => {
        console.log(`[3] Bundled ${batch.messages.length} messages.`);
        const finalMessages = [...batch.messages];
        const currentBatch = activeBatches.get(shield_id);
        activeBatches.delete(shield_id);

        // --- EXTRACT ONLY THE TEXT FOR AI ---
        const cleanTextForAI = finalMessages.map(m => m.text || m.body || "").join(" ").trim();
        
        console.log(`[4] AI checking text: "${cleanTextForAI}"`);
        const aiDecision = await checkSpamWithGroq(cleanTextForAI);
        
        console.log(`[Security Check] Decision: ${aiDecision}`);
        if (aiDecision.includes('BLOCK')) {
            console.log(`[SHIELD] Delivery stopped.`);
            return;
        }

        try {
            await fetch(currentBatch.destination_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shield_id, messages: finalMessages })
            });
            console.log(`[6] SUCCESS! Forwarded to Make.com`);
        } catch (err) { console.error('[ERROR] Failed', err); }
    }, batch.delay_timer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NodeShield Pro Engine active on ${PORT}`));
