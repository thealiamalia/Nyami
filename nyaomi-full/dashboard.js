// Simple local dashboard (EJS optional). This is a minimal placeholder that serves as a starting point.
// To run: `node dashboard.js` (ensure dependencies installed and .env set)
import express from 'express';
import path from 'path';
const app = express();
const PORT = process.env.PORT || 3000;
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
app.get('/', (req,res) => {
  res.send('<h2>Nyaomi Dashboard</h2><p>This is a minimal dashboard placeholder. For full dashboard, expand this file or use the web UI provided earlier.</p>');
});
app.listen(PORT, ()=>console.log(`Dashboard listening on ${PORT}`));
