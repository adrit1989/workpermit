require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const PDFDocument = require('pdfkit'); 
const ExcelJS = require('exceljs'); 
const { BlobServiceClient } = require('@azure/storage-blob');
const { getConnection, sql } = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.')));

// --- AZURE STORAGE ---
const AZURE_CONN_STR = process.env.AZURE_STORAGE_CONNECTION_STRING;
let containerClient, kmlContainerClient;
if (AZURE_CONN_STR) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN_STR);
        containerClient = blobServiceClient.getContainerClient("permit-attachments");
        kmlContainerClient = blobServiceClient.getContainerClient("map-layers");
        (async () => {
            try { await containerClient.createIfNotExists(); } catch(e) {}
            try { await kmlContainerClient.createIfNotExists({ access: 'blob' }); } catch(e) {}
        })();
    } catch (err) { console.error("Blob Storage Error:", err.message); }
}
const upload = multer({ storage: multer.memoryStorage() });

// --- HELPERS ---
function getNowIST() { return new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''); }
function formatDate(dateStr) { if (!dateStr) return '-'; const d = new Date(dateStr); if (isNaN(d.getTime())) return dateStr; return d.toLocaleString("en-GB", { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''); }

// --- ROUTES ---
app.post('/api/login', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('role', sql.NVarChar, req.body.role).input('email', sql.NVarChar, req.body.name).input('pass', sql.NVarChar, req.body.password).query('SELECT * FROM Users WHERE Role = @role AND Email = @email AND Password = @pass');
        if (result.recordset.length > 0) res.json({ success: true, user: result.recordset[0] }); else res.json({ success: false, message: "Invalid Credentials" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/api/add-user', async (req, res) => {
    try {
        const { name, email, role, password } = req.body;
        if (!name || !email || !role || !password) return res.status(400).json({ error: "All fields required" });
        const pool = await getConnection();
        const check = await pool.request().input('e', sql.NVarChar, email).query("SELECT * FROM Users WHERE Email = @e");
        if(check.recordset.length > 0) return res.status(400).json({ error: "User exists" });
        await pool.request().input('n', sql.NVarChar, name).input('e', sql.NVarChar, email).input('r', sql.NVarChar, role).input('p', sql.NVarChar, password).query("INSERT INTO Users (Name, Email, Role, Password) VALUES (@n, @e, @r, @p)");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dashboard', async (req, res) => {
    try {
        const { role, email } = req.body;
        const pool = await getConnection();
        const result = await pool.request().query('SELECT PermitID, Status, ValidFrom, ValidTo, RequesterEmail, ReviewerEmail, ApproverEmail, FullDataJSON FROM Permits');
        const permits = result.recordset.map(p => ({ ...JSON.parse(p.FullDataJSON || "{}"), PermitID: p.PermitID, Status: p.Status, ValidFrom: p.ValidFrom, ValidTo: p.ValidTo }));
        const filtered = permits.filter(p => {
            const st = (p.Status || "").toLowerCase();
            if (role === 'Requester') return p.RequesterEmail === email;
            if (role === 'Reviewer') return (p.ReviewerEmail === email && (st.includes('pending review') || st.includes('closure') || st === 'closed' || st.includes('renewal')));
            if (role === 'Approver') return (p.ApproverEmail === email && (st.includes('pending approval') || st === 'active' || st === 'closed' || st.includes('renewal') || st.includes('closure')));
            return false;
        });
        res.json(filtered.sort((a, b) => b.PermitID.localeCompare(a.PermitID)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// SAVE PERMIT (Align with new fields)
app.post('/api/save-permit', upload.single('file'), async (req, res) => {
    try {
        const vf = new Date(req.body.ValidFrom); const vt = new Date(req.body.ValidTo);
        if (vt <= vf) return res.status(400).json({ error: "End time must be greater than Start time." });
        
        const pool = await getConnection();
        let permitId = req.body.PermitID && req.body.PermitID !== 'undefined' && req.body.PermitID !== 'null' ? String(req.body.PermitID) : null;
        let isUpdate = false;

        if (permitId) {
            const checkReq = pool.request();
            const check = await checkReq.input('pid', sql.NVarChar, permitId).query("SELECT Status FROM Permits WHERE PermitID = @pid");
            if (check.recordset.length > 0) {
                if (check.recordset[0].Status === 'Pending Review' || check.recordset[0].Status === 'New') isUpdate = true;
                else return res.status(400).json({ error: "Cannot edit processed permit." });
            } else permitId = null;
        }

        if (!permitId) {
            const idReq = pool.request();
            const idRes = await idReq.query("SELECT TOP 1 PermitID FROM Permits ORDER BY Id DESC");
            const lastId = idRes.recordset.length > 0 ? idRes.recordset[0].PermitID : "WP-1000";
            permitId = `WP-${parseInt(lastId.split('-')[1]) + 1}`;
        }

        // Save all new fields into JSON
        const fullData = { ...req.body, PermitID: permitId };
        const saveReq = pool.request();
        // Note: Using generic inputs to handle all new text fields
        saveReq.input('pid', sql.NVarChar, permitId).input('status', sql.NVarChar, 'Pending Review')
               .input('wt', sql.NVarChar, req.body.WorkType).input('req', sql.NVarChar, req.body.RequesterEmail)
               .input('rev', sql.NVarChar, req.body.ReviewerEmail).input('app', sql.NVarChar, req.body.ApproverEmail)
               .input('vf', sql.DateTime, vf).input('vt', sql.DateTime, vt)
               .input('lat', sql.NVarChar, req.body.Latitude || null).input('lng', sql.NVarChar, req.body.Longitude || null)
               .input('locSno', sql.NVarChar, req.body.LocationPermitSno).input('iso', sql.NVarChar, req.body.RefIsolationCert)
               .input('cross', sql.NVarChar, req.body.CrossRefPermits).input('jsa', sql.NVarChar, req.body.JsaRef)
               .input('mocReq', sql.NVarChar, req.body.MocRequired).input('mocRef', sql.NVarChar, req.body.MocRef)
               .input('cctv', sql.NVarChar, req.body.CctvAvailable).input('cctvDet', sql.NVarChar, req.body.CctvDetail)
               .input('vendor', sql.NVarChar, req.body.Vendor).input('dept', sql.NVarChar, req.body.IssuedToDept)
               .input('locUnit', sql.NVarChar, req.body.LocationUnit).input('exactLoc', sql.NVarChar, req.body.ExactLocation)
               .input('desc', sql.NVarChar, req.body.Desc).input('offName', sql.NVarChar, req.body.OfficialName)
               .input('json', sql.NVarChar, JSON.stringify(fullData));

        if (isUpdate) {
            await saveReq.query(`UPDATE Permits SET WorkType=@wt, ReviewerEmail=@rev, ApproverEmail=@app, ValidFrom=@vf, ValidTo=@vt, Latitude=@lat, Longitude=@lng, LocationPermitSno=@locSno, RefIsolationCert=@iso, CrossRefPermits=@cross, JsaRef=@jsa, MocRequired=@mocReq, MocRef=@mocRef, CctvAvailable=@cctv, CctvDetail=@cctvDet, Vendor=@vendor, IssuedToDept=@dept, LocationUnit=@locUnit, ExactLocation=@exactLoc, [Desc]=@desc, OfficialName=@offName, FullDataJSON=@json, Status='Pending Review' WHERE PermitID=@pid`);
        } else {
            await saveReq.query(`INSERT INTO Permits (PermitID, Status, WorkType, RequesterEmail, ReviewerEmail, ApproverEmail, ValidFrom, ValidTo, Latitude, Longitude, LocationPermitSno, RefIsolationCert, CrossRefPermits, JsaRef, MocRequired, MocRef, CctvAvailable, CctvDetail, Vendor, IssuedToDept, LocationUnit, ExactLocation, [Desc], OfficialName, RenewalsJSON, FullDataJSON) VALUES (@pid, @status, @wt, @req, @rev, @app, @vf, @vt, @lat, @lng, @locSno, @iso, @cross, @jsa, @mocReq, @mocRef, @cctv, @cctvDet, @vendor, @dept, @locUnit, @exactLoc, @desc, @offName, '[]', @json)`);
        }
        if(req.file && containerClient) await containerClient.getBlockBlobClient(`${permitId}_${req.file.originalname}`).uploadData(req.file.buffer);
        res.json({ success: true, permitId: permitId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-status', async (req, res) => {
    try {
        const { PermitID, action, role, user, ...extras } = req.body;
        const pool = await getConnection();
        const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if(current.recordset.length === 0) return res.json({ error: "Not found" });
        
        let p = current.recordset[0];
        let data = JSON.parse(p.FullDataJSON);
        let status = p.Status;
        const now = getNowIST();
        const sig = `${user} on ${now}`;
        Object.assign(data, extras);

        if (role === 'Requester' && action === 'initiate_closure') { status = 'Closure Pending Review'; data.Closure_Receiver_Sig = sig; data.Site_Restored_Check = "Yes"; data.Closure_Requestor_Remarks = req.body.Closure_Requestor_Remarks; data.Closure_Requestor_Date = now; }
        else if (role === 'Reviewer') {
            if (action === 'reject') { status = 'Rejected'; data.Reviewer_Remarks = (data.Reviewer_Remarks||"") + `\n[Rejected by ${user}: ${req.body.comment}]`; }
            else if (action === 'review') { status = 'Pending Approval'; data.Reviewer_Sig = sig; data.Reviewer_Remarks = req.body.comment; }
            else if (action === 'approve') { status = 'Closure Pending Approval'; data.Closure_Reviewer_Remarks = req.body.Closure_Reviewer_Remarks; data.Closure_Reviewer_Date = now; data.Closure_Reviewer_Sig = sig; }
            else if (action === 'reject_closure') { status = 'Active'; data.Closure_Reviewer_Remarks = `[REJECTED]: ${req.body.Closure_Reviewer_Remarks}`; data.Closure_Reviewer_Date = now; }
        }
        else if (role === 'Approver') {
            if (action === 'reject') { status = 'Rejected'; data.Approver_Remarks = (data.Approver_Remarks||"") + `\n[Rejected by ${user}: ${req.body.comment}]`; }
            else if (action === 'approve' && status === 'Pending Approval') { status = 'Active'; data.Approver_Sig = sig; data.Approver_Remarks = req.body.comment; }
            else if (action === 'approve') { status = 'Closed'; data.Closure_Approver_Remarks = req.body.Closure_Approver_Remarks; data.Closure_Approver_Date = now; data.Closure_Issuer_Sig = sig; }
            else if (action === 'reject_closure') { status = 'Active'; data.Closure_Approver_Remarks = `[REJECTED]: ${req.body.Closure_Approver_Remarks}`; data.Closure_Approver_Date = now; }
        }

        let q = pool.request().input('pid', sql.NVarChar, PermitID).input('status', sql.NVarChar, status).input('json', sql.NVarChar, JSON.stringify(data));
        if(extras.WorkType) q.input('wt', sql.NVarChar, extras.WorkType).query("UPDATE Permits SET Status = @status, FullDataJSON = @json, WorkType = @wt WHERE PermitID = @pid");
        else q.query("UPDATE Permits SET Status = @status, FullDataJSON = @json WHERE PermitID = @pid");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/permit-data', async (req, res) => { try { const pool = await getConnection(); const result = await pool.request().input('pid', sql.NVarChar, req.body.permitId).query("SELECT * FROM Permits WHERE PermitID = @pid"); if (result.recordset.length === 0) return res.json({ error: "Not found" }); const p = result.recordset[0]; res.json({ ...JSON.parse(p.FullDataJSON), PermitID: p.PermitID, Status: p.Status, RenewalsJSON: p.RenewalsJSON, Latitude: p.Latitude, Longitude: p.Longitude }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/renewal', async (req, res) => { try { const { PermitID, userRole, userName, action, rejectionReason, ...data } = req.body; const pool = await getConnection(); const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT RenewalsJSON, Status, ValidFrom, ValidTo FROM Permits WHERE PermitID = @pid"); let renewals = JSON.parse(current.recordset[0].RenewalsJSON || "[]"); let status = current.recordset[0].Status; const now = getNowIST(); if (userRole === 'Requester') { renewals.push({ status: 'pending_review', valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTill, hc: data.RenewalHC, toxic: data.RenewalToxic, oxygen: data.RenewalOxygen, precautions: data.RenewalPrecautions, req_name: userName, req_at: now }); status = "Renewal Pending Review"; } else if (userRole === 'Reviewer') { const last = renewals[renewals.length - 1]; if (action === 'reject') { last.status = 'rejected'; last.rev_name = userName; last.rev_at = now; last.rejection_reason = rejectionReason; status = 'Active'; } else { last.status = 'pending_approval'; last.rev_name = userName; last.rev_at = now; Object.assign(last, { valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTill, hc: data.RenewalHC, toxic: data.RenewalToxic, oxygen: data.RenewalOxygen, precautions: data.RenewalPrecautions }); status = "Renewal Pending Approval"; } } else if (userRole === 'Approver') { const last = renewals[renewals.length - 1]; if (action === 'reject') { last.status = 'rejected'; last.app_name = userName; last.app_at = now; last.rejection_reason = rejectionReason; status = 'Active'; } else { last.status = 'approved'; last.app_name = userName; last.app_at = now; status = "Active"; } } await pool.request().input('pid', sql.NVarChar, PermitID).input('status', sql.NVarChar, status).input('ren', sql.NVarChar, JSON.stringify(renewals)).query("UPDATE Permits SET Status = @status, RenewalsJSON = @ren WHERE PermitID = @pid"); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/map-data', async (req, res) => { try { const pool = await getConnection(); const result = await pool.request().query("SELECT PermitID, FullDataJSON, Latitude, Longitude FROM Permits WHERE Status = 'Active' AND Latitude IS NOT NULL"); res.json(result.recordset.map(row => { const d = JSON.parse(row.FullDataJSON); return { PermitID: row.PermitID, lat: parseFloat(row.Latitude), lng: parseFloat(row.Longitude), WorkType: d.WorkType, Desc: d.Desc, ExactLocation: d.ExactLocation }; })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/kml', async (req, res) => { if(!kmlContainerClient) return res.json([]); let b=[]; for await(const x of kmlContainerClient.listBlobsFlat()) b.push({name:x.name,url:kmlContainerClient.getBlockBlobClient(x.name).url}); res.json(b); }); app.post('/api/kml', upload.single('file'), async (req, res) => { if(!kmlContainerClient) return; const b = kmlContainerClient.getBlockBlobClient(`${Date.now()}-${req.file.originalname}`); await b.uploadData(req.file.buffer, {blobHTTPHeaders:{blobContentType:"application/vnd.google-earth.kml+xml"}}); res.json({success:true, url:b.url}); }); app.delete('/api/kml/:name', async (req, res) => { if(!kmlContainerClient) return; await kmlContainerClient.getBlockBlobClient(req.params.name).delete(); res.json({success:true}); });
app.post('/api/stats', async (req, res) => { try { const pool = await getConnection(); const result = await pool.request().query("SELECT Status, WorkType FROM Permits"); const s={}, t={}; result.recordset.forEach(r => { s[r.Status]=(s[r.Status]||0)+1; t[r.WorkType]=(t[r.WorkType]||0)+1; }); res.json({ success: true, statusCounts: s, typeCounts: t }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/download-excel', async (req, res) => { try { const pool = await getConnection(); const result = await pool.request().query("SELECT * FROM Permits ORDER BY Id DESC"); const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Permits'); worksheet.columns = [{header:'ID',key:'id'},{header:'Status',key:'status'},{header:'Work',key:'wt'},{header:'Req',key:'req'},{header:'From',key:'vf'},{header:'To',key:'vt'}]; result.recordset.forEach(r => { const d = JSON.parse(r.FullDataJSON); worksheet.addRow({id:r.PermitID, status:r.Status, wt:d.WorkType, req:d.RequesterName, vf:formatDate(r.ValidFrom), vt:formatDate(r.ValidTo)}); }); res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition','attachment; filename=Permits.xlsx'); await workbook.xlsx.write(res); res.end(); } catch (e) { res.status(500).send(e.message); } });

// ==========================================
// 12. PDF GENERATION (MATCHING ANNEXURE-1)
// ==========================================
app.get('/api/download-pdf/:id', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('pid', sql.NVarChar, req.params.id).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if(result.recordset.length === 0) return res.status(404).send('Not Found');
        const p = result.recordset[0];
        const d = JSON.parse(p.FullDataJSON);
        const doc = new PDFDocument({ margin: 30, size: 'A4', bufferPages: true });

        // Load custom Hindi font if available (Otherwise falls back to Helvetica and ignores Hindi)
        // doc.font('fonts/Mangal.ttf'); // Uncomment if you upload font file

        res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename=${p.PermitID}.pdf`); doc.pipe(res);

        // -- LOGOS & HEADER --
        // To use real logos, upload 'iocl_logo.png' and 'rhino_logo.png' to root folder
        // doc.image('iocl_logo.png', 40, 40, {width: 50}); 
        // doc.image('rhino_logo.png', 500, 40, {width: 50});

        doc.rect(30, 30, 535, 80).stroke();
        doc.font('Helvetica-Bold').fontSize(14).text('INDIAN OIL CORPORATION LIMITED', 85, 45, { align: 'center', width: 425 });
        doc.fontSize(10).text('EASTERN REGION PIPELINES', 85, 65, { align: 'center', width: 425 });
        doc.fontSize(12).text('COMPOSITE WORK PERMIT', 85, 85, { align: 'center', width: 425, underline:true });
        
        doc.moveDown(5);

        // -- PERMIT DETAILS GRID --
        doc.fontSize(9).font('Helvetica');
        const startY = doc.y;
        
        // Manual Grid Drawing for Header
        const drawRow = (label, value, y) => {
            doc.font('Helvetica-Bold').text(label, 40, y);
            doc.font('Helvetica').text(value || '-', 200, y);
        };
        
        drawRow(`Permit No: ${p.PermitID}`, `Work Type: ${d.WorkType}`, startY);
        drawRow(`Valid From: ${formatDate(p.ValidFrom)}`, `Valid To: ${formatDate(p.ValidTo)}`, startY + 15);
        drawRow(`Location: ${d.ExactLocation} (${d.LocationUnit})`, `Issued To: ${d.IssuedToDept}`, startY + 30);
        drawRow(`Vendor: ${d.Vendor}`, `Emergency Contact: ${d.EmergencyContact}`, startY + 45);
        drawRow(`JSA Ref: ${d.JsaRef}`, `Cross Ref: ${d.CrossRefPermits}`, startY + 60);
        
        doc.y = startY + 80;

        // -- CHECKLIST TABLES --
        const drawTable = (title, qs, idPrefix) => {
            doc.moveDown();
            doc.font('Helvetica-Bold').text(title);
            doc.fontSize(8).font('Helvetica');
            let y = doc.y + 5;
            
            // Header
            doc.rect(40, y, 30, 20).stroke().text('SN', 45, y+5);
            doc.rect(70, y, 300, 20).stroke().text('Check Point', 75, y+5);
            doc.rect(370, y, 50, 20).stroke().text('Status', 375, y+5);
            doc.rect(420, y, 145, 20).stroke().text('Remarks', 425, y+5);
            y += 20;

            qs.forEach((q, i) => {
                const ans = d[q.id] === 'Yes' ? 'YES' : (d[q.id] === 'NA' ? 'NA' : '-');
                const rem = q.id === "GP_Q12" ? `Tox:${d.GP_Q12_ToxicGas||'-'} HC:${d.GP_Q12_HC||'-'} O2:${d.GP_Q12_Oxygen||'-'}` : (d[q.d] || '');
                
                // Row
                const h = 20;
                if(y > 750) { doc.addPage(); y = 40; }
                
                doc.rect(40, y, 30, h).stroke().text(i+1, 45, y+5);
                doc.rect(70, y, 300, h).stroke().text(q.t, 75, y+5, {width: 290});
                doc.rect(370, y, 50, h).stroke().text(ans, 375, y+5);
                doc.rect(420, y, 145, h).stroke().text(rem, 425, y+5);
                y += h;
            });
            doc.y = y;
        };

        const gpQs = [{id:"GP_Q1", t:"Equipment/Work Area Inspected"}, {id:"GP_Q2", t:"Surrounding Area Cleaned"}, {id:"GP_Q3", t:"Sewer Manhole Covered"}, {id:"GP_Q4", t:"Hazards Considered"}, {id:"GP_Q5", t:"Equipment Blinded", d:"GP_Q5_Detail"}, {id:"GP_Q6", t:"Drained & Depressurized"}, {id:"GP_Q7", t:"Steamed/Purged"}, {id:"GP_Q8", t:"Water Flushed"}, {id:"GP_Q9", t:"Fire Tender Access"}, {id:"GP_Q10", t:"Iron Sulfide Removed"}, {id:"GP_Q11", t:"Electrically Isolated", d:"GP_Q11_Detail"}, {id:"GP_Q12", t:"Gas Test (Toxic/HC/O2)"}, {id:"GP_Q13", t:"Fire Extinguisher"}, {id:"GP_Q14", t:"Area Cordoned Off"}, {id:"GP_Q15", t:"CCTV Monitoring"}];
        drawTable('SECTION A: GENERAL CHECKLIST', gpQs);

        doc.addPage();
        const spQs = [{id:"HW_Q1", t:"Proper ventilation/Lighting"}, {id:"HW_Q2", t:"Means of Exit/Escape"}, {id:"HW_Q3", t:"Standby Person"}, {id:"HW_Q4", t:"Trapped Oil/Gas Check"}, {id:"HW_Q5", t:"Shield Against Spark"}, {id:"HW_Q6", t:"Equipment Grounded"}, {id:"HW_Q16", t:"Height Permit Taken", d:"HW_Q16_Detail"}, {id:"VE_Q1", t:"Spark Arrestor (Vehicles)"}, {id:"EX_Q1", t:"Excavation Shoring/Sloping"}];
        drawTable('SECTION B/C/D: SPECIFIC CHECKLISTS', spQs);

        // -- HAZARDS & PPE --
        doc.moveDown();
        doc.font('Helvetica-Bold').text('HAZARDS & PRECAUTIONS');
        const hazards = ["H_H2S", "H_LackOxygen", "H_Corrosive", "H_ToxicGas", "H_Combustible", "H_Steam", "H_PyroIron", "H_N2Gas", "H_Height", "H_LooseEarth", "H_HighNoise", "H_Radiation", "H_Other"];
        const ppe = ["P_FaceShield", "P_FreshAirMask", "P_CompressedBA", "P_Goggles", "P_DustRespirator", "P_Earmuff", "P_LifeLine", "P_Apron", "P_SafetyHarness", "P_SafetyNet", "P_Airline"];
        
        let hList = hazards.filter(h => d[h] === 'Y').map(h => h.replace('H_','')).join(', ');
        if(d.H_Other === 'Y' && d.H_Other_Detail) hList += ` (Other: ${d.H_Other_Detail})`;
        let pList = ppe.filter(p => d[p] === 'Y').map(p => p.replace('P_','')).join(', ');

        doc.rect(40, doc.y, 525, 60).stroke();
        doc.fontSize(9).font('Helvetica').text(`HAZARDS: ${hList || 'None'}`, 45, doc.y + 5, {width: 515});
        doc.text(`PPE REQUIRED: ${pList || 'Standard'}`, 45, doc.y + 25, {width: 515});
        doc.text(`ADDITIONAL PRECAUTIONS: ${d.AdditionalPrecautions || 'None'}`, 45, doc.y + 45, {width: 515});
        doc.y += 70;

        // -- SIGNATURES --
        doc.font('Helvetica-Bold').text('DIGITAL SIGNATURES (ISSUANCE)');
        let y = doc.y;
        doc.rect(40, y, 175, 40).stroke().text(`REQUESTER\n${d.RequesterName}\n${formatDate(p.ValidFrom)}`, 45, y+5);
        doc.rect(215, y, 175, 40).stroke().text(`REVIEWER (SAFETY)\n${splitSig(d.Reviewer_Sig).name}\n${splitSig(d.Reviewer_Sig).date}`, 220, y+5);
        doc.rect(390, y, 175, 40).stroke().text(`APPROVER (ISSUER)\n${splitSig(d.Approver_Sig).name}\n${splitSig(d.Approver_Sig).date}`, 395, y+5);
        doc.y += 50;

        // -- RENEWALS --
        doc.addPage();
        doc.font('Helvetica-Bold').text('CLEARANCE RENEWAL HISTORY');
        const rens = JSON.parse(p.RenewalsJSON || "[]");
        y = doc.y + 5;
        doc.rect(40, y, 100, 20).stroke().text('Date/Time', 45, y+5);
        doc.rect(140, y, 100, 20).stroke().text('Readings', 145, y+5);
        doc.rect(240, y, 325, 20).stroke().text('Signatures (Req / Rev / App)', 245, y+5);
        y += 20;
        
        rens.forEach(r => {
            doc.rect(40, y, 100, 30).stroke().text(`${formatDate(r.valid_from)}\nto\n${formatDate(r.valid_till)}`, 45, y+5);
            doc.rect(140, y, 100, 30).stroke().text(`HC:${r.hc} Tox:${r.toxic}\nO2:${r.oxygen}`, 145, y+5);
            doc.rect(240, y, 325, 30).stroke().text(`${r.req_name} | ${r.rev_name||'-'} | ${r.app_name||'-'}`, 245, y+10);
            y += 30;
        });
        doc.y = y + 20;

        // -- CLOSURE --
        doc.font('Helvetica-Bold').text('CLOSURE OF WORK PERMIT');
        y = doc.y + 5;
        doc.rect(40, y, 525, 80).stroke();
        doc.text('1. Receiver (Job Done & Site Cleared):', 45, y+5);
        doc.font('Helvetica').text(`${d.Closure_Requestor_Remarks || '-'} (${d.Closure_Requestor_Date || '-'})`, 250, y+5);
        
        doc.font('Helvetica-Bold').text('2. Safety Officer (Verified):', 45, y+30);
        doc.font('Helvetica').text(`${d.Closure_Reviewer_Remarks || '-'} (${d.Closure_Reviewer_Date || '-'})`, 250, y+30);
        
        doc.font('Helvetica-Bold').text('3. Issuer (Permit Closed):', 45, y+55);
        doc.font('Helvetica').text(`${d.Closure_Approver_Remarks || '-'} (${d.Closure_Approver_Date || '-'})`, 250, y+55);

        // WATERMARK
        const wmText = p.Status.includes('Closed') ? 'CLOSED' : 'ACTIVE';
        const wmColor = p.Status.includes('Closed') ? '#ef4444' : '#22c55e';
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) { doc.switchToPage(i); doc.save(); doc.rotate(-45, { origin: [300, 400] }); doc.fontSize(80).fillColor(wmColor).opacity(0.15).text(wmText, 100, 350, { align: 'center', width: 400 }); doc.restore(); }
        
        doc.end();
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(8080, () => console.log('Server running on 8080'));
