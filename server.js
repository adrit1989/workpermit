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
app.use(express.static(path.join(__dirname, '.')));

// --- AZURE BLOB SETUP ---
const AZURE_CONN_STR = process.env.AZURE_STORAGE_CONNECTION_STRING;
let containerClient, kmlContainerClient;

if (AZURE_CONN_STR) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN_STR);
        containerClient = blobServiceClient.getContainerClient("permit-attachments");
        kmlContainerClient = blobServiceClient.getContainerClient("map-layers");
        (async () => {
            await containerClient.createIfNotExists();
            await kmlContainerClient.createIfNotExists({ access: 'blob' });
        })();
    } catch (err) { console.error("Blob Storage Error:", err.message); }
}

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
            .input('email', sql.NVarChar, req.body.name) 
            .input('pass', sql.NVarChar, req.body.password)
            .query('SELECT * FROM Users WHERE Role = @role AND Email = @email AND Password = @pass');
        
        if (result.recordset.length > 0) res.json({ success: true, user: result.recordset[0] });
        else res.json({ success: false, message: "Invalid Credentials" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. GET USERS
app.get('/api/users', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query('SELECT Name, Role, Email FROM Users');
        res.json({
            Requesters: result.recordset.filter(u => u.Role === 'Requester').map(u => ({ name: u.Name, email: u.Email })),
            Reviewers: result.recordset.filter(u => u.Role === 'Reviewer').map(u => ({ name: u.Name, email: u.Email })),
            Approvers: result.recordset.filter(u => u.Role === 'Approver').map(u => ({ name: u.Name, email: u.Email }))
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. DASHBOARD
app.post('/api/dashboard', async (req, res) => {
    try {
        const { role, email } = req.body;
        const pool = await getConnection();
        const result = await pool.request().query('SELECT PermitID, Status, ValidFrom, ValidTo, RequesterEmail, ReviewerEmail, ApproverEmail, FullDataJSON FROM Permits');
        
        const permits = result.recordset.map(p => {
            const d = JSON.parse(p.FullDataJSON || "{}");
            return { ...d, PermitID: p.PermitID, Status: p.Status, ValidFrom: p.ValidFrom, ValidTo: p.ValidTo };
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
        const idRes = await pool.request().query("SELECT TOP 1 PermitID FROM Permits ORDER BY Id DESC");
        const lastId = idRes.recordset.length > 0 ? idRes.recordset[0].PermitID : "WP-1000";
        const newId = `WP-${parseInt(lastId.split('-')[1]) + 1}`;

        const fullData = { ...req.body, PermitID: newId };
        
        await pool.request()
            .input('pid', sql.NVarChar, newId)
            .input('status', sql.NVarChar, 'Pending Review')
            .input('wt', sql.NVarChar, req.body.WorkType)
            .input('req', sql.NVarChar, req.body.RequesterEmail)
            .input('rev', sql.NVarChar, req.body.ReviewerEmail)
            .input('app', sql.NVarChar, req.body.ApproverEmail)
            .input('vf', sql.DateTime, new Date(req.body.ValidFrom))
            .input('vt', sql.DateTime, new Date(req.body.ValidTo))
            .input('lat', sql.NVarChar, req.body.Latitude || null)
            .input('lng', sql.NVarChar, req.body.Longitude || null)
            
            // Map Specific Columns
            .input('locSno', sql.NVarChar, req.body.LocationPermitSno)
            .input('iso', sql.NVarChar, req.body.RefIsolationCert)
            .input('cross', sql.NVarChar, req.body.CrossRefPermits)
            .input('jsa', sql.NVarChar, req.body.JsaRef)
            .input('mocReq', sql.NVarChar, req.body.MocRequired)
            .input('mocRef', sql.NVarChar, req.body.MocRef)
            .input('cctv', sql.NVarChar, req.body.CctvAvailable)
            .input('cctvDet', sql.NVarChar, req.body.CctvDetail)
            .input('vendor', sql.NVarChar, req.body.Vendor)
            .input('dept', sql.NVarChar, req.body.IssuedToDept)
            .input('locUnit', sql.NVarChar, req.body.LocationUnit)
            .input('exactLoc', sql.NVarChar, req.body.ExactLocation)
            .input('desc', sql.NVarChar, req.body.Desc)
            .input('offName', sql.NVarChar, req.body.OfficialName)

            .input('json', sql.NVarChar, JSON.stringify(fullData))
            .query(`INSERT INTO Permits (PermitID, Status, WorkType, RequesterEmail, ReviewerEmail, ApproverEmail, ValidFrom, ValidTo, Latitude, Longitude, 
                    LocationPermitSno, RefIsolationCert, CrossRefPermits, JsaRef, MocRequired, MocRef, CctvAvailable, CctvDetail, Vendor, IssuedToDept, LocationUnit, ExactLocation, [Desc], OfficialName, RenewalsJSON, FullDataJSON) 
                    VALUES (@pid, @status, @wt, @req, @rev, @app, @vf, @vt, @lat, @lng, 
                    @locSno, @iso, @cross, @jsa, @mocReq, @mocRef, @cctv, @cctvDet, @vendor, @dept, @locUnit, @exactLoc, @desc, @offName, '[]', @json)`);

        res.json({ success: true, permitId: newId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. UPDATE STATUS
app.post('/api/update-status', async (req, res) => {
    try {
        const { PermitID, action, role, user, comment, ...extras } = req.body;
        const pool = await getConnection();
        const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if(current.recordset.length === 0) return res.json({ error: "Not found" });
        
        let p = current.recordset[0];
        let data = JSON.parse(p.FullDataJSON);
        let status = p.Status;
        const now = getNowIST();
        const sig = `${user} on ${now}`;

        if (role === 'Reviewer') {
            if (action === 'reject') { status = 'Rejected'; data.Reviewer_Remarks = (data.Reviewer_Remarks||"") + `\n[Rejected by ${user}: ${comment}]`; }
            else if (action === 'review') { status = 'Pending Approval'; data.Reviewer_Sig = sig; data.Reviewer_Remarks = comment; Object.assign(data, extras); }
            else if (action === 'approve' && status.includes('Closure')) { status = 'Closure Pending Approval'; data.Reviewer_Remarks = (data.Reviewer_Remarks||"") + `\n[Closure Verified by ${user} on ${now}]`; }
        }
        else if (role === 'Approver') {
            if (action === 'reject') { status = 'Rejected'; data.Approver_Remarks = (data.Approver_Remarks||"") + `\n[Rejected by ${user}: ${comment}]`; }
            else if (action === 'approve' && status === 'Pending Approval') { status = 'Active'; data.Approver_Sig = sig; data.Approver_Remarks = comment; Object.assign(data, extras); }
            else if (action === 'approve' && status.includes('Closure')) { status = 'Closed'; data.Closure_Issuer_Sig = sig; data.Closure_Issuer_Remarks = comment; }
        }
        else if (role === 'Requester' && action === 'initiate_closure') {
            status = 'Closure Pending Review'; data.Closure_Receiver_Sig = sig;
        }

        let q = pool.request()
            .input('pid', sql.NVarChar, PermitID)
            .input('status', sql.NVarChar, status)
            .input('json', sql.NVarChar, JSON.stringify(data));
            
        if(extras.ForceBackgroundColor) {
             q.input('bg', sql.NVarChar, extras.ForceBackgroundColor)
              .query("UPDATE Permits SET Status = @status, FullDataJSON = @json, ForceBackgroundColor = @bg WHERE PermitID = @pid");
        } else {
             q.query("UPDATE Permits SET Status = @status, FullDataJSON = @json WHERE PermitID = @pid");
        }

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
        res.json({ ...JSON.parse(p.FullDataJSON), PermitID: p.PermitID, Status: p.Status, RenewalsJSON: p.RenewalsJSON, Latitude: p.Latitude, Longitude: p.Longitude });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. RENEWALS
app.post('/api/renewal', async (req, res) => {
    try {
        const { PermitID, userRole, userName, action, ...data } = req.body;
        const pool = await getConnection();
        const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT RenewalsJSON, Status, ValidFrom, ValidTo FROM Permits WHERE PermitID = @pid");
        
        let renewals = JSON.parse(current.recordset[0].RenewalsJSON || "[]");
        let status = current.recordset[0].Status;
        const now = getNowIST();

        if (userRole === 'Requester') {
             renewals.push({ status: 'pending_review', valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTill, hc: data.RenewalHC, toxic: data.RenewalToxic, oxygen: data.RenewalOxygen, precautions: data.RenewalPrecautions, req_sig: `${userName} on ${now}` });
             status = "Renewal Pending Review";
        } 
        else if (userRole === 'Reviewer') {
            const last = renewals[renewals.length - 1];
            if (action === 'reject') { last.status = 'rejected'; last.rev_sig = `${userName} (Rejected)`; status = 'Active'; }
            else { 
                last.status = 'pending_approval'; last.rev_sig = `${userName} on ${now}`; 
                Object.assign(last, { valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTill, hc: data.RenewalHC, toxic: data.RenewalToxic, oxygen: data.RenewalOxygen, precautions: data.RenewalPrecautions });
                status = "Renewal Pending Approval"; 
            }
        }
        else if (userRole === 'Approver') {
            const last = renewals[renewals.length - 1];
            if (action === 'reject') { last.status = 'rejected'; last.app_sig = `${userName} (Rejected)`; status = 'Active'; }
            else { last.status = 'approved'; last.app_sig = `${userName} on ${now}`; status = "Active"; }
        }

        await pool.request().input('pid', sql.NVarChar, PermitID).input('status', sql.NVarChar, status).input('ren', sql.NVarChar, JSON.stringify(renewals))
            .query("UPDATE Permits SET Status = @status, RenewalsJSON = @ren WHERE PermitID = @pid");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 8. MAP DATA
app.post('/api/map-data', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query("SELECT PermitID, FullDataJSON, Latitude, Longitude FROM Permits WHERE Status = 'Active' AND Latitude IS NOT NULL");
        const mapPoints = result.recordset.map(row => {
            const d = JSON.parse(row.FullDataJSON);
            return { PermitID: row.PermitID, lat: parseFloat(row.Latitude), lng: parseFloat(row.Longitude), WorkType: d.WorkType, Desc: d.Desc, RequesterName: d.RequesterName, ValidFrom: d.ValidFrom, ValidTo: d.ValidTo };
        });
        res.json(mapPoints);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9. KML LAYERS
app.get('/api/kml', async (req, res) => {
    if(!kmlContainerClient) return res.json([]);
    try {
        let blobs = [];
        for await (const blob of kmlContainerClient.listBlobsFlat()) {
            blobs.push({ name: blob.name, url: kmlContainerClient.getBlockBlobClient(blob.name).url });
        }
        res.json(blobs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kml', upload.single('file'), async (req, res) => {
    if(!kmlContainerClient) return res.status(500).json({error: "Storage not configured"});
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const blobName = `${Date.now()}-${req.file.originalname}`;
        const blockBlobClient = kmlContainerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer, { blobHTTPHeaders: { blobContentType: "application/vnd.google-earth.kml+xml" } });
        res.json({ success: true, url: blockBlobClient.url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kml/:name', async (req, res) => {
    if(!kmlContainerClient) return res.status(500).json({error: "Storage not configured"});
    try {
        await kmlContainerClient.getBlockBlobClient(req.params.name).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 10. REPORT & STATS
app.post('/api/report', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query("SELECT * FROM Permits");
        const report = result.recordset.map(r => {
            const d = JSON.parse(r.FullDataJSON);
            return [r.PermitID, d.Desc, r.ValidFrom, r.ValidTo, d.RequesterName, d.Vendor, d.LocationUnit, d.ExactLocation, r.Status];
        });
        report.unshift(["Permit ID", "Work Details", "Valid From", "Valid To", "Requester Name", "Vendor", "Location Unit", "Exact Location", "Status"]);
        res.json({ success: true, data: report });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stats', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query("SELECT Status FROM Permits");
        const stats = { total: 0, counts: {} };
        result.recordset.forEach(r => { stats.total++; stats.counts[r.Status] = (stats.counts[r.Status] || 0) + 1; });
        res.json({ success: true, stats });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 11. PDF DOWNLOAD (FULL FORMAT)
app.get('/api/download-pdf/:id', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('pid', sql.NVarChar, req.params.id).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if(result.recordset.length === 0) return res.status(404).send('Not Found');
        
        const p = result.recordset[0];
        const d = JSON.parse(p.FullDataJSON);
        const doc = new PDFDocument({ margin: 30 });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${p.PermitID}.pdf`);
        doc.pipe(res);

        // Header
        doc.font('Helvetica-Bold').fontSize(16).text('INDIAN OIL CORPORATION LIMITED', { align: 'center' });
        doc.fontSize(12).text('Pipeline Division - WORK PERMIT', { align: 'center' });
        doc.moveDown();

        // Main Details
        const startY = doc.y;
        doc.font('Helvetica').fontSize(10);
        doc.text(`Permit ID: ${p.PermitID}`, 50, startY);
        doc.text(`Status: ${p.Status}`, 300, startY);
        doc.text(`Work Type: ${d.WorkType}`, 50, startY + 15);
        doc.text(`Location: ${d.ExactLocation} (${d.LocationUnit})`, 300, startY + 15);
        doc.text(`Valid From: ${new Date(p.ValidFrom).toLocaleString()}`, 50, startY + 30);
        doc.text(`Valid To: ${new Date(p.ValidTo).toLocaleString()}`, 300, startY + 30);
        
        doc.moveDown(3);
        doc.text(`Description: ${d.Desc || '-'}`);
        doc.text(`Vendor: ${d.Vendor || '-'} | Dept: ${d.IssuedToDept || '-'}`);
        doc.text(`Location Permit S/N: ${d.LocationPermitSno || '-'} | Isolation Cert: ${d.RefIsolationCert || '-'}`);
        doc.text(`JSA Ref: ${d.JsaRef || '-'} | Cross Ref: ${d.CrossRefPermits || '-'}`);
        doc.text(`MOC Req: ${d.MocRequired || 'No'} | Ref: ${d.MocRef || '-'} | CCTV: ${d.CctvAvailable || 'No'}`);
        doc.moveDown();

        // Checklists
        doc.font('Helvetica-Bold').text('SAFETY CHECKLISTS', {underline:true});
        doc.font('Helvetica').fontSize(9);
        
        const drawChecklist = (items) => {
            items.forEach(key => {
                if(d[key] === 'Y') doc.text(`[X] ${key}`);
            });
        };
        
        // General Points & Hazards
        doc.text('Hazards Considered:');
        const hazards = ["H_H2S", "H_LackOxygen", "H_Corrosive", "H_ToxicGas", "H_Combustible", "H_Steam", "H_PyroIron", "H_N2Gas", "H_Height", "H_LooseEarth", "H_HighNoise", "H_Radiation", "H_Other"];
        hazards.forEach(h => { if(d[h] === 'Y') doc.text(` - ${h.replace('H_', '')}`); });
        
        doc.moveDown();
        doc.text('PPE Required:');
        const ppe = ["P_FaceShield", "P_FreshAirMask", "P_CompressedBA", "P_Goggles", "P_DustRespirator", "P_Earmuff", "P_LifeLine", "P_Apron", "P_SafetyHarness", "P_SafetyNet", "P_Airline", "P_GasResponder", "P_CottonCoverall"];
        ppe.forEach(item => { if(d[item] === 'Y') doc.text(` - ${item.replace('P_', '')}`); });

        doc.moveDown();
        doc.font('Helvetica-Bold').text('SIGNATURES');
        doc.font('Helvetica');
        doc.text(`Requester: ${d.RequesterName} (${d.RequesterEmail})`);
        doc.text(`Reviewer: ${d.Reviewer_Sig || 'Pending'} | Remarks: ${d.Reviewer_Remarks || '-'}`);
        doc.text(`Approver: ${d.Approver_Sig || 'Pending'} | Remarks: ${d.Approver_Remarks || '-'}`);
        
        doc.moveDown();
        doc.font('Helvetica-Bold').text('RENEWALS & CLOSURE');
        doc.font('Helvetica');
        if (p.RenewalsJSON) {
            const rens = JSON.parse(p.RenewalsJSON);
            rens.forEach(r => doc.text(`Renewal: ${r.valid_from} to ${r.valid_till} (${r.status})`));
        }
        
        doc.text(`Closure Receiver: ${d.Closure_Receiver_Sig || 'Not Signed'}`);
        doc.text(`Closure Issuer: ${d.Closure_Issuer_Sig || 'Not Signed'}`);
        
        doc.end();
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ SYSTEM LIVE ON PORT ${PORT}`));
