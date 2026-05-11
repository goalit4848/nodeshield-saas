const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const activeBatches = new Map();

app.post('/api/shield/:shield_id', async (req, res) => {
    const { shield_id } = req.params;
    
    console.log(`\n[1] Message arrived from Unipile for: ${shield_id}`);
    res.status(200).send("Buffered");

    if (!activeBatches.has(shield_id)) {
        activeBatches.set(shield_id, { messages: [], timerId: null, destination_url: null, delay_timer: 15000 });
        
        supabase.from('users').select('destination_url, delay_timer').eq('shield_id', shield_id).single()
            .then(({ data }) => {
                if (data) {
                    const b = activeBatches.get(shield_id);
                    if (b) {
                        b.destination_url = data.destination_url;
                        if (data.delay_timer) b.delay_timer = data.delay_timer;
                    }
                }
            });
    }

    const batch = activeBatches.get(shield_id);
    batch.messages.push(req.body);

    clearTimeout(batch.timerId);
    console.log(`[2] Timer restarted. Waiting 15s...`);

    batch.timerId = setTimeout(async () => {
        console.log(`[3] Timer finished. Bundled ${batch.messages.length} messages.`);
        
        const finalMessages = [...batch.messages];
        const destUrl = batch.destination_url;
        activeBatches.delete(shield_id);

        if (!destUrl) {
            return console.log("[ERROR] Supabase failed to provide the Make.com URL!");
        }

        const extractedChatId = finalMessages[0]?.account_info?.chat_id || '';
        const justTheText = finalMessages.map(item => item.sender?.message || '').join(' | ');

        console.log(`[4] Bypassing AI temporarily. Sending directly to Make.com...`);
        
        try {
            const response = await fetch(destUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shield_id, chat_id: extractedChatId, text_for_ai: justTheText, total_messages_bundled: finalMessages.length })
            });
            console.log(`[5] SUCCESS! Make.com caught it (Status: ${response.status})`);
        } catch (err) { 
            console.error('[ERROR] Make.com failed to receive:', err); 
        }

    }, batch.delay_timer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine active on ${PORT}`));
