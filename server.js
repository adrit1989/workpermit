require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const PDFDocument = require('pdfkit');
const { BlobServiceClient } = require('@azure/storage-blob');
const { getConnection, sql } = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// Serve Static Frontend
app.use(express.static(path.join(__dirname, '.')));

// --- AZURE BLOB SETUP ---
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient("permit-attachments");

// Multer (Memory Storage for Azure Uploads)
const upload = multer({ storage: multer.memoryStorage() });

// --- UTILS ---
function getNowIST() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }); }

// --- API ROUTES ---

// 1. LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('role', sql.NVarChar, req.body.role)
            .input('email', sql.NVarChar, req.body.name) // Assuming login uses name in your UI, but email is safer
            .input('pass', sql.NVarChar, req.body.password)
            .query('SELECT * FROM Users WHERE Role = @role AND Name = @email AND Password = @pass'); // Adjusted to match your UI logic
        
        if (result.recordset.length > 0) {
            res.json({ success: true, user: result.recordset[0] });
        } else {
            res.json({ success: false, message: "Invalid Credentials" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. GET USERS
app.get('/api/users', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query('SELECT Name, Role, Email FROM Users');
        const users = result.recordset;
        
        res.json({
            Requesters: users.filter(u => u.Role === 'Requester').map(u => ({ name: u.Name, email: u.Email })),
            Reviewers: users.filter(u => u.Role === 'Reviewer').map(u => ({ name: u.Name, email: u.Email })),
            Approvers: users.filter(u => u.Role === 'Approver').map(u => ({ name: u.Name, email: u.Email }))
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. DASHBOARD
app.post('/api/dashboard', async (req, res) => {
    try {
        const { role, email } = req.body;
        const pool = await getConnection();
        let query = 'SELECT * FROM Permits';
        
        // Note: Simple filtering. For high volume, filter in SQL WHERE clause.
        const result = await pool.request().query(query);
        
        const permits = result.recordset.map(p => {
            const fullData = JSON.parse(p.FullDataJSON || "{}");
            return { ...fullData, PermitID: p.PermitID, Status: p.Status, ValidFrom: p.ValidFrom, ValidTo: p.ValidTo };
        });

        const filtered = permits.filter(p => {
            const st = (p.Status || "").toLowerCase();
            if (role === 'Requester') return p.RequesterEmail === email;
            if (role === 'Reviewer') return (p.ReviewerEmail === email && (st.includes('pending review') || st.includes('closure') || st === 'closed' || st.includes('renewal')));
            if (role === 'Approver') return (p.ApproverEmail === email && (st.includes('pending approval') || st === 'active' || st === 'closed'));
            return false;
        });
        
        res.json(filtered.sort((a, b) => b.PermitID.localeCompare(a.PermitID)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. SAVE PERMIT
app.post('/api/save-permit', upload.single('file'), async (req, res) => {
    try {
        const pool = await getConnection();
        
        // Generate ID (Simplified for SQL)
        const idRes = await pool.request().query("SELECT TOP 1 PermitID FROM Permits ORDER BY Id DESC");
        const lastId = idRes.recordset.length > 0 ? idRes.recordset[0].PermitID : "WP-1000";
        const newId = `WP-${parseInt(lastId.split('-')[1]) + 1}`;

        // File Upload to Azure Blob
        let filename = null;
        if (req.file) {
            filename = `${newId}-${Date.now()}-${req.file.originalname}`;
            const blockBlobClient = containerClient.getBlockBlobClient(filename);
            await blockBlobClient.uploadData(req.file.buffer);
        }

        const fullData = { ...req.body, PermitID: newId, Attachment: filename };
        
        await pool.request()
            .input('pid', sql.NVarChar, newId)
            .input('status', sql.NVarChar, 'Pending Review')
            .input('wt', sql.NVarChar, req.body.WorkType)
            .input('req', sql.NVarChar, req.body.RequesterEmail)
            .input('rev', sql.NVarChar, req.body.ReviewerEmail)
            .input('app', sql.NVarChar, req.body.ApproverEmail)
            .input('vf', sql.DateTime, new Date(req.body.ValidFrom))
            .input('vt', sql.DateTime, new Date(req.body.ValidTo))
            .input('json', sql.NVarChar, JSON.stringify(fullData))
            .query(`INSERT INTO Permits (PermitID, Status, WorkType, RequesterEmail, ReviewerEmail, ApproverEmail, ValidFrom, ValidTo, RenewalsJSON, FullDataJSON) 
                    VALUES (@pid, @status, @wt, @req, @rev, @app, @vf, @vt, '[]', @json)`);

        res.json({ success: true, permitId: newId });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// 5. UPDATE STATUS
app.post('/api/update-status', async (req, res) => {
    try {
        const { PermitID, action, role, user, comment, ...extras } = req.body;
        const pool = await getConnection();
        
        // Get current data
        const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if(current.recordset.length === 0) return res.json({ error: "Not found" });
        
        let p = current.recordset[0];
        let data = JSON.parse(p.FullDataJSON);
        let status = p.Status;
        const now = getNowIST();
        const sig = `${user} on ${now}`;

        // Logic (Same as before, simplified)
        if (role === 'Reviewer') {
            if (action === 'reject') { status = 'Rejected'; data.Reviewer_Remarks += `\nRejected: ${comment}`; }
            else if (action === 'review') { status = 'Pending Approval'; data.Reviewer_Sig = sig; data.Reviewer_Remarks = comment; Object.assign(data, extras); }
            else if (action === 'approve') { status = 'Closure Pending Approval'; data.Reviewer_Remarks += `\n[Closure Verified]`; }
        }
        else if (role === 'Approver') {
            if (action === 'reject') { status = 'Rejected'; data.Approver_Remarks = comment; }
            else if (action === 'approve' && status === 'Pending Approval') { status = 'Active'; data.Approver_Sig = sig; data.Approver_Remarks = comment; }
            else if (action === 'approve' && status.includes('Closure')) { status = 'Closed'; data.Closure_Issuer_Sig = sig; data.Closure_Issuer_Remarks = comment; }
        }
        else if (role === 'Requester') {
            if (action === 'initiate_closure') { status = 'Closure Pending Review'; data.Closure_Receiver_Sig = sig; }
        }

        // Update SQL
        await pool.request()
            .input('pid', sql.NVarChar, PermitID)
            .input('status', sql.NVarChar, status)
            .input('json', sql.NVarChar, JSON.stringify(data))
            .query("UPDATE Permits SET Status = @status, FullDataJSON = @json WHERE PermitID = @pid");

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. PERMIT DATA
app.post('/api/permit-data', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('pid', sql.NVarChar, req.body.permitId).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if (result.recordset.length === 0) return res.json({ error: "Not found" });
        
        const p = result.recordset[0];
        const fullData = JSON.parse(p.FullDataJSON);
        // Merge SQL columns back into JSON for Frontend compatibility
        res.json({ ...fullData, PermitID: p.PermitID, Status: p.Status, RenewalsJSON: p.RenewalsJSON });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. RENEWALS
app.post('/api/renewal', async (req, res) => {
    try {
        const { PermitID, userRole, userName, action, ...data } = req.body;
        const pool = await getConnection();
        const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT RenewalsJSON, Status FROM Permits WHERE PermitID = @pid");
        
        let renewals = JSON.parse(current.recordset[0].RenewalsJSON || "[]");
        let status = current.recordset[0].Status;
        const now = getNowIST();

        if (userRole === 'Requester') {
             renewals.push({ status: 'pending_review', valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTill, hc: data.RenewalHC, toxic: data.RenewalToxic, oxygen: data.RenewalOxygen, precautions: data.RenewalPrecautions, req_sig: `${userName} on ${now}` });
             status = "Renewal Pending Review";
        } else if (userRole === 'Reviewer') {
            const last = renewals[renewals.length - 1];
            if (action === 'reject') { last.status = 'rejected'; status = 'Active'; }
            else { last.status = 'approved'; last.rev_sig = `${userName} on ${now}`; status = "Active"; }
        }

        await pool.request()
            .input('pid', sql.NVarChar, PermitID)
            .input('status', sql.NVarChar, status)
            .input('ren', sql.NVarChar, JSON.stringify(renewals))
            .query("UPDATE Permits SET Status = @status, RenewalsJSON = @ren WHERE PermitID = @pid");
            
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));