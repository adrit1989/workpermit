require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { BlobServiceClient } = require('@azure/storage-blob');
const { getConnection, sql } = require('./db');

// --- SECURITY PACKAGES ---
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();

// --- 1. NONCE GENERATOR ---
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// --- 2. SECURITY: MAXIMUM STRICTNESS CSP ---
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Strict: Only allow scripts with our Nonce
          (req, res) => `'nonce-${res.locals.nonce}'`,
          "https://cdn.jsdelivr.net", // For Chart.js
          "https://maps.googleapis.com" // For Google Maps
        ],
        styleSrc: [
          "'self'", 
          // REMOVED 'unsafe-inline'. We now load styles from /public/app.css
          "https://fonts.googleapis.com"
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://maps.gstatic.com", "https://maps.googleapis.com"],
        connectSrc: ["'self'", "https://maps.googleapis.com", "https://cdn.jsdelivr.net"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    }
  })
);

// --- 3. CORS ---
const allowedOrigins = [
  "https://workpermit-a8hueufcdzc0ftcd.centralindia-01.azurewebsites.net",
  "http://localhost:3000"
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return cb(new Error('CORS Policy Blocked this Origin'), false);
    }
    return cb(null, true);
  },
  credentials: true,
  methods: "GET,POST,PUT,DELETE,OPTIONS"
}));

app.use(bodyParser.json({ limit: '50mb' }));
// Serve the public folder (where app.css now lives)
app.use('/public', express.static(path.join(__dirname, 'public')));

if (!process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET missing.");
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
const AZURE_CONN_STR = process.env.AZURE_STORAGE_CONNECTION_STRING;

// --- 4. RATE LIMITS ---
const apiLimiter = rateLimit({ windowMs: 10 * 1000, max: 50, message: "Too many requests" });
app.use('/api/', apiLimiter);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: "Too many login attempts" });

// --- AZURE SETUP ---
let containerClient;
if (AZURE_CONN_STR) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN_STR);
        containerClient = blobServiceClient.getContainerClient("permit-attachments");
        (async () => { try { await containerClient.createIfNotExists(); } catch (e) { } })();
    } catch (err) { console.error("Blob Error:", err.message); }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- 5. AUTH MIDDLEWARE ---
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 
    if (!token) return res.sendStatus(401); 
    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) return res.sendStatus(403); 
        try {
            const pool = await getConnection();
            const r = await pool.request().input('e', sql.NVarChar, user.email).query('SELECT LastPasswordChange FROM Users WHERE Email=@e');
            if (r.recordset.length === 0) return res.sendStatus(401);
            const dbLastPwd = r.recordset[0].LastPasswordChange ? Math.floor(new Date(r.recordset[0].LastPasswordChange).getTime() / 1000) : 0;
            if (dbLastPwd > (user.lastPwd || 0)) return res.status(401).json({ error: "Session expired" });
            req.user = user; 
            next(); 
        } catch (dbErr) { return res.sendStatus(500); }
    });
}

// --- HELPER FUNCTIONS ---
function getNowIST() { return new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', ''); }
function formatDate(dateStr) { if (!dateStr) return '-'; const d = new Date(dateStr); if (isNaN(d.getTime())) return dateStr; return d.toLocaleString("en-GB", { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''); }
function getOrdinal(n) { const s = ["th", "st", "nd", "rd"]; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
async function uploadToAzure(buffer, blobName, mimeType = "image/jpeg") {
    if (!containerClient) return null;
    try {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(buffer, { blobHTTPHeaders: { blobContentType: mimeType } });
        return blockBlobClient.url;
    } catch (error) { return null; }
}

// --- PDF GENERATOR ---
async function drawPermitPDF(doc, p, d, renewalsList) {
    const workType = (d.WorkType || "PERMIT").toUpperCase();
    const status = p.Status || "Active";
    let watermarkText = (status === 'Closed' || status.includes('Closure')) ? `CLOSED - ${workType}` : `ACTIVE - ${workType}`;

    const drawWatermark = () => {
        doc.save(); doc.translate(doc.page.width/2, doc.page.height/2); doc.rotate(-45);
        doc.font('Helvetica-Bold').fontSize(60).fillColor('#ff0000').opacity(0.15);
        doc.text(watermarkText, -300, -30, { align: 'center', width: 600 });
        doc.restore(); doc.opacity(1);
    };

    const bgColor = d.PdfBgColor || 'White';
    const compositePermitNo = `${d.IssuedToDept || 'DEPT'}/${p.PermitID}`;

    const drawHeader = (doc, bgColor, permitNoStr) => {
        if (bgColor && bgColor !== 'Auto' && bgColor !== 'White') {
            const colorMap = { 'Red': '#fee2e2', 'Green': '#dcfce7', 'Yellow': '#fef9c3' };
            doc.save(); doc.fillColor(colorMap[bgColor] || 'white');
            doc.rect(0, 0, doc.page.width, doc.page.height).fill(); doc.restore();
        }
        drawWatermark();
        const startX = 30, startY = 30;
        doc.lineWidth(1); doc.rect(startX, startY, 535, 95).stroke(); doc.rect(startX, startY, 80, 95).stroke(); 
        const logoPath = path.join(__dirname, 'public', 'logo.png');
        if (fs.existsSync(logoPath)) { try { doc.image(logoPath, startX, startY, { fit: [80, 95], align: 'center', valign: 'center' }); } catch (err) {} }
        doc.rect(startX + 80, startY, 320, 95).stroke();
        doc.font('Helvetica-Bold').fontSize(11).fillColor('black').text('INDIAN OIL CORPORATION LIMITED', startX+80, startY+15, { width: 320, align: 'center' });
        doc.fontSize(9).text('EASTERN REGION PIPELINES', startX+80, startY+30, { width: 320, align: 'center' });
        doc.text('HSE DEPT.', startX+80, startY+45, { width: 320, align: 'center' });
        doc.fontSize(8).text('COMPOSITE WORK/ COLD WORK/HOT WORK/ENTRY TO CONFINED SPACE/VEHICLE ENTRY / EXCAVATION WORK', startX+80, startY+65, { width: 320, align: 'center' });
        doc.rect(startX + 400, startY, 135, 95).stroke();
        doc.fontSize(8).font('Helvetica');
        doc.text('Doc No: ERPL/HS&E/25-26', startX+405, startY+60); doc.text('Issue No: 01', startX+405, startY+70); doc.text('Date: 01.09.2025', startX+405, startY+80);
        if (permitNoStr) { doc.font('Helvetica-Bold').fontSize(10).fillColor('red'); doc.text(`Permit No: ${permitNoStr}`, startX+405, startY+15, { width: 130, align: 'left' }); doc.fillColor('black'); }
    };

    drawHeader(doc, bgColor, compositePermitNo); doc.y = 135; doc.fontSize(9).font('Helvetica');

    const bannerPath = path.join(__dirname, 'public', 'safety_banner.png');
    if (fs.existsSync(bannerPath)) { try { doc.image(bannerPath, 30, doc.y, { width: 535, height: 100 }); doc.y += 110; } catch (err) {} }
    
    // Standard PDF body rendering (Simplified for brevity, assumes standard logic)
    doc.text(`(i) Work clearance from: ${formatDate(p.ValidFrom)} to ${formatDate(p.ValidTo)}`, 30, doc.y);
    doc.text(`(ii) Issued to: ${d.IssuedToDept || '-'} / ${d.Vendor || '-'}`, 30, doc.y);
    doc.end();
}

// --- API ROUTES ---
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const pool = await getConnection();
        const r = await pool.request().input('e', sql.NVarChar, req.body.name).query('SELECT * FROM Users WHERE Email=@e');
        if (r.recordset.length === 0) return res.json({ success: false });
        const user = r.recordset[0];
        const validPassword = await bcrypt.compare(req.body.password, user.Password);
        if (!validPassword || user.Role !== req.body.role) return res.json({ success: false });
        const lastPwdTime = user.LastPasswordChange ? Math.floor(new Date(user.LastPasswordChange).getTime() / 1000) : 0;
        const token = jwt.sign({ name: user.Name, email: user.Email, role: user.Role, lastPwd: lastPwdTime }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ success: true, token, user: { Name: user.Name, Email: user.Email, Role: user.Role } });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.get('/api/users', async (req, res) => {
    try {
        const pool = await getConnection();
        const r = await pool.request().query('SELECT Name, Email, Role FROM Users');
        const mapU = u => ({ name: u.Name, email: u.Email, role: u.Role });
        res.json({
            Requesters: r.recordset.filter(u => u.Role === 'Requester').map(mapU),
            Reviewers: r.recordset.filter(u => u.Role === 'Reviewer').map(mapU),
            Approvers: r.recordset.filter(u => u.Role === 'Approver').map(mapU)
        });
    } catch (e) { res.status(500).json({ error: "Server Error" }) }
});

app.post('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const { role, email } = req.user; 
        const pool = await getConnection();
        const r = await pool.request().query("SELECT PermitID, Status, ValidFrom, ValidTo, RequesterEmail, ReviewerEmail, ApproverEmail, FullDataJSON, FinalPdfUrl FROM Permits");
        const p = r.recordset.map(x => {
            let baseData = {};
            if (x.FullDataJSON) { try { baseData = JSON.parse(x.FullDataJSON); } catch(e) {} }
            return { ...baseData, PermitID: x.PermitID, Status: x.Status, ValidFrom: x.ValidFrom, RequesterEmail: x.RequesterEmail, ReviewerEmail: x.ReviewerEmail, ApproverEmail: x.ApproverEmail, FinalPdfUrl: x.FinalPdfUrl };
        });
        const f = p.filter(x => (role === 'Requester' ? x.RequesterEmail === email : true));
        res.json(f.sort((a, b) => b.PermitID.localeCompare(a.PermitID)));
    } catch (e) { res.status(500).json({ error: "Server Error" }) }
});

app.post('/api/save-permit', authenticateToken, upload.any(), async (req, res) => {
    try {
        const requesterEmail = req.user.email; 
        let vf, vt;
        try { vf = new Date(req.body.ValidFrom); vt = new Date(req.body.ValidTo); } catch (err) { return res.status(400).json({ error: "Invalid Date" }); }
        if (vt <= vf) return res.status(400).json({ error: "Date Error" });

        const pool = await getConnection();
        let pid = req.body.PermitID;
        if (!pid) {
            const idRes = await pool.request().query("SELECT TOP 1 PermitID FROM Permits ORDER BY Id DESC");
            const lastId = idRes.recordset.length > 0 ? idRes.recordset[0].PermitID : 'WP-1000';
            pid = `WP-${parseInt(lastId.split('-')[1] || 1000) + 1}`;
        }

        let workers = [];
        try { workers = JSON.parse(req.body.SelectedWorkers); } catch(e) {}
        let renewalsArr = [];
        if (req.body.InitRen === 'Y') {
            const renImageFile = req.files ? req.files.find(f => f.fieldname === 'InitRenImage') : null;
            let photoUrl = renImageFile ? await uploadToAzure(renImageFile.buffer, `${pid}-1stRenewal.jpg`) : null;
            renewalsArr.push({
                status: 'pending_review', valid_from: req.body.InitRenFrom, valid_till: req.body.InitRenTo,
                hc: req.body.InitRenHC, toxic: req.body.InitRenTox, oxygen: req.body.InitRenO2,
                precautions: req.body.InitRenPrec, req_name: req.body.RequesterName, req_at: getNowIST(),
                worker_list: workers.map(w => w.Name), photoUrl: photoUrl
            });
        }
        const permitData = { ...req.body, SelectedWorkers: workers, PermitID: pid, CreatedDate: getNowIST(), GSR_Accepted: 'Y' };
        
        const q = pool.request()
            .input('p', sql.NVarChar, pid).input('s', sql.NVarChar, 'Pending Review').input('w', sql.NVarChar, req.body.WorkType)
            .input('re', sql.NVarChar, requesterEmail).input('rv', sql.NVarChar, req.body.ReviewerEmail).input('ap', sql.NVarChar, req.body.ApproverEmail)
            .input('vf', sql.DateTime, vf).input('vt', sql.DateTime, vt)
            .input('lat', sql.NVarChar, req.body.Latitude || null).input('lng', sql.NVarChar, req.body.Longitude || null)
            .input('j', sql.NVarChar(sql.MAX), JSON.stringify(permitData)).input('ren', sql.NVarChar(sql.MAX), JSON.stringify(renewalsArr));

        const chk = await pool.request().input('p', pid).query("SELECT Status FROM Permits WHERE PermitID=@p");
        if (chk.recordset.length > 0) { await q.query("UPDATE Permits SET FullDataJSON=@j, WorkType=@w, ValidFrom=@vf, ValidTo=@vt, Latitude=@lat, Longitude=@lng, RenewalsJSON=@ren WHERE PermitID=@p"); } 
        else { await q.query("INSERT INTO Permits (PermitID, Status, WorkType, RequesterEmail, ReviewerEmail, ApproverEmail, ValidFrom, ValidTo, Latitude, Longitude, FullDataJSON, RenewalsJSON) VALUES (@p, @s, @w, @re, @rv, @ap, @vf, @vt, @lat, @lng, @j, @ren)"); }
        res.json({ success: true, permitId: pid });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/update-status', authenticateToken, async (req, res) => {
    try {
        const { PermitID, action, ...extras } = req.body;
        const role = req.user.role; const user = req.user.name; 
        const pool = await getConnection();
        const cur = await pool.request().input('p', PermitID).query("SELECT * FROM Permits WHERE PermitID=@p");
        if (cur.recordset.length === 0) return res.json({ error: "Not found" });

        let st = cur.recordset[0].Status;
        let d = JSON.parse(cur.recordset[0].FullDataJSON);
        let renewals = JSON.parse(cur.recordset[0].RenewalsJSON || "[]");
        const now = getNowIST();
        Object.assign(d, extras);

        if (renewals.length === 1) {
            const r1 = renewals[0];
            if (r1.status === 'pending_review' || r1.status === 'pending_approval') {
                if (action === 'reject') { r1.status = 'rejected'; r1.rej_by = user; r1.rej_reason = "Rejected"; } 
                else if (role === 'Reviewer' && action === 'review') { r1.status = 'pending_approval'; r1.rev_name = user; r1.rev_at = now; } 
                else if (role === 'Approver' && action === 'approve') { r1.status = 'approved'; r1.app_name = user; r1.app_at = now; }
            }
        }
        if (action === 'reject_closure') st = 'Active';
        else if (role === 'Reviewer' && action === 'approve_closure') { st = 'Closure Pending Approval'; d.Closure_Reviewer_Sig = `${user} on ${now}`; d.Closure_Reviewer_Date = now; }
        else if (role === 'Approver' && action === 'approve' && st.includes('Closure')) { st = 'Closed'; d.Closure_Issuer_Sig = `${user} on ${now}`; d.Closure_Approver_Date = now; d.Closure_Approver_Sig = `${user} on ${now}`; }
        else if (action === 'approve' && role === 'Approver') { st = 'Active'; d.Approver_Sig = `${user} on ${now}`; }
        else if (action === 'initiate_closure') { st = 'Closure Pending Review'; d.Closure_Requestor_Date = now; d.Closure_Receiver_Sig = `${user} on ${now}`; }
        else if (action === 'reject') st = 'Rejected';
        else if (role === 'Reviewer' && action === 'review') { st = 'Pending Approval'; d.Reviewer_Sig = `${user} on ${now}`; }

        let finalPdfUrl = null;
        let finalJson = JSON.stringify(d);
        if (st === 'Closed') {
             const pdfRecord = { ...cur.recordset[0], Status: 'Closed', PermitID: PermitID, ValidFrom: cur.recordset[0].ValidFrom, ValidTo: cur.recordset[0].ValidTo };
             const pdfBuffer = await new Promise(async (resolve, reject) => {
                const doc = new PDFDocument({ margin: 30, size: 'A4', bufferPages: true });
                const buffers = []; doc.on('data', buffers.push.bind(buffers)); doc.on('end', () => resolve(Buffer.concat(buffers))); doc.on('error', reject);
                try { await drawPermitPDF(doc, pdfRecord, d, renewals); doc.end(); } catch(e) { doc.end(); reject(e); }
             });
             finalPdfUrl = await uploadToAzure(pdfBuffer, `closed-permits/${PermitID}_FINAL.pdf`, "application/pdf");
             if(finalPdfUrl) finalJson = null;
        }

        const q = pool.request().input('p', PermitID).input('s', st).input('r', JSON.stringify(renewals));
        if (finalPdfUrl) { await q.input('url', finalPdfUrl).query("UPDATE Permits SET Status=@s, FullDataJSON=NULL, RenewalsJSON=NULL, FinalPdfUrl=@url WHERE PermitID=@p"); } 
        else { await q.input('j', finalJson).query("UPDATE Permits SET Status=@s, FullDataJSON=@j, RenewalsJSON=@r WHERE PermitID=@p"); }
        res.json({ success: true, archived: !!finalPdfUrl });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/renewal', authenticateToken, upload.any(), async (req, res) => {
    try {
        const { PermitID, action, rejectionReason, renewalWorkers, oddHourReq, ...renFields } = req.body;
        const userRole = req.user.role; const userName = req.user.name;
        const pool = await getConnection();
        const cur = await pool.request().input('p', PermitID).query("SELECT RenewalsJSON, Status, ValidFrom, ValidTo FROM Permits WHERE PermitID=@p");
        if (cur.recordset[0].Status === 'Closed') return res.status(400).json({ error: "Permit is CLOSED." });

        let r = JSON.parse(cur.recordset[0].RenewalsJSON || "[]");
        const now = getNowIST();

        if (userRole === 'Requester') {
            const rs = new Date(renFields.RenewalValidFrom); const re = new Date(renFields.RenewalValidTo);
            if (re <= rs) return res.status(400).json({ error: "End time error" });
            if ((re - rs) > 8 * 60 * 60 * 1000) return res.status(400).json({ error: "Max 8 Hours" });

            const photoFile = req.files ? req.files.find(f => f.fieldname === 'RenewalImage') : null;
            let photoUrl = photoFile ? await uploadToAzure(photoFile.buffer, `${PermitID}-${getOrdinal(r.length+1)}Renewal.jpg`) : null;

            r.push({
                status: 'pending_review', valid_from: renFields.RenewalValidFrom, valid_till: renFields.RenewalValidTo,
                hc: renFields.hc, toxic: renFields.toxic, oxygen: renFields.oxygen, precautions: renFields.precautions,
                req_name: userName, req_at: now, worker_list: JSON.parse(renewalWorkers || "[]"), photoUrl: photoUrl, odd_hour_req: (oddHourReq === 'Y')
            });
        } else {
            const last = r[r.length-1];
            if (action === 'reject') { last.status = 'rejected'; last.rej_by = userName; last.rej_reason = rejectionReason; }
            else {
                last.status = userRole === 'Reviewer' ? 'pending_approval' : 'approved';
                if(userRole === 'Reviewer') { last.rev_name = userName; last.rev_at = now; }
                if(userRole === 'Approver') { last.app_name = userName; last.app_at = now; }
            }
        }
        let newStatus = r[r.length - 1].status === 'approved' ? 'Active' : (r[r.length - 1].status === 'rejected' ? 'Active' : 'Renewal Pending ' + (userRole === 'Requester' ? 'Review' : 'Approval'));
        await pool.request().input('p', PermitID).input('r', JSON.stringify(r)).input('s', newStatus).query("UPDATE Permits SET RenewalsJSON=@r, Status=@s WHERE PermitID=@p");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

// --- 8. SERVE FRONTEND (WITH NONCE) ---
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, 'utf8', (err, htmlData) => {
        if (err) return res.status(500).send('Error');
        const finalHtml = htmlData.replace(/NONCE_PLACEHOLDER/g, res.locals.nonce);
        res.send(finalHtml);
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
