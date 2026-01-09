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

// --- AZURE BLOB SETUP ---
const AZURE_CONN_STR = process.env.AZURE_STORAGE_CONNECTION_STRING;
let containerClient, kmlContainerClient;

if (AZURE_CONN_STR) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN_STR);
        containerClient = blobServiceClient.getContainerClient("permit-attachments");
        kmlContainerClient = blobServiceClient.getContainerClient("map-layers");
        (async () => {
            try { await containerClient.createIfNotExists(); } catch(e){}
            try { await kmlContainerClient.createIfNotExists({ access: 'blob' }); } catch(e){}
        })();
    } catch (err) { console.error("Blob Storage Error:", err.message); }
}

const upload = multer({ storage: multer.memoryStorage() });

function getNowIST() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }); }

// --- API ROUTES ---

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
            if (role === 'Approver') return (p.ApproverEmail === email && (st.includes('pending approval') || st === 'active' || st === 'closed' || st.includes('renewal') || st.includes('closure')));
            return false;
        });
        res.json(filtered.sort((a, b) => b.PermitID.localeCompare(a.PermitID)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-permit', upload.single('file'), async (req, res) => {
    try {
        const vf = new Date(req.body.ValidFrom);
        const vt = new Date(req.body.ValidTo);
        if (vt <= vf) return res.status(400).json({ error: "End time must be greater than Start time." });
        const diffDays = Math.ceil(Math.abs(vt - vf) / (1000 * 60 * 60 * 24)); 
        if (diffDays > 7) return res.status(400).json({ error: "Permit duration cannot exceed 7 days." });

        const pool = await getConnection();
        const idRes = await pool.request().query("SELECT TOP 1 PermitID FROM Permits ORDER BY Id DESC");
        const lastId = idRes.recordset.length > 0 ? idRes.recordset[0].PermitID : "WP-1000";
        const newId = `WP-${parseInt(lastId.split('-')[1]) + 1}`;
        const fullData = { ...req.body, PermitID: newId };
        
        await pool.request()
            .input('pid', sql.NVarChar, newId).input('status', sql.NVarChar, 'Pending Review')
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
            .input('json', sql.NVarChar, JSON.stringify(fullData))
            .query(`INSERT INTO Permits (PermitID, Status, WorkType, RequesterEmail, ReviewerEmail, ApproverEmail, ValidFrom, ValidTo, Latitude, Longitude, LocationPermitSno, RefIsolationCert, CrossRefPermits, JsaRef, MocRequired, MocRef, CctvAvailable, CctvDetail, Vendor, IssuedToDept, LocationUnit, ExactLocation, [Desc], OfficialName, RenewalsJSON, FullDataJSON) VALUES (@pid, @status, @wt, @req, @rev, @app, @vf, @vt, @lat, @lng, @locSno, @iso, @cross, @jsa, @mocReq, @mocRef, @cctv, @cctvDet, @vendor, @dept, @locUnit, @exactLoc, @desc, @offName, '[]', @json)`);
        res.json({ success: true, permitId: newId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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
        Object.assign(data, extras);

        if (role === 'Reviewer') {
            if (action === 'reject') { status = 'Rejected'; data.Reviewer_Remarks = (data.Reviewer_Remarks||"") + `\n[Rejected by ${user}: ${comment}]`; }
            else if (action === 'review') { status = 'Pending Approval'; data.Reviewer_Sig = sig; data.Reviewer_Remarks = comment; }
            else if (action === 'approve' && status.includes('Closure')) { status = 'Closure Pending Approval'; data.Reviewer_Remarks = (data.Reviewer_Remarks||"") + `\n[Closure Verified by ${user} on ${now}]`; }
        }
        else if (role === 'Approver') {
            if (action === 'reject') { status = 'Rejected'; data.Approver_Remarks = (data.Approver_Remarks||"") + `\n[Rejected by ${user}: ${comment}]`; }
            else if (action === 'approve' && status === 'Pending Approval') { status = 'Active'; data.Approver_Sig = sig; data.Approver_Remarks = comment; }
            else if (action === 'approve' && status.includes('Closure')) { status = 'Closed'; data.Closure_Issuer_Sig = sig; data.Closure_Issuer_Remarks = comment; }
        }
        else if (role === 'Requester' && action === 'initiate_closure') {
            status = 'Closure Pending Review'; data.Closure_Receiver_Sig = sig;
        }

        let q = pool.request().input('pid', sql.NVarChar, PermitID).input('status', sql.NVarChar, status).input('json', sql.NVarChar, JSON.stringify(data));
        if(extras.WorkType) q.input('wt', sql.NVarChar, extras.WorkType).query("UPDATE Permits SET Status = @status, FullDataJSON = @json, WorkType = @wt WHERE PermitID = @pid");
        else q.query("UPDATE Permits SET Status = @status, FullDataJSON = @json WHERE PermitID = @pid");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/permit-data', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('pid', sql.NVarChar, req.body.permitId).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if (result.recordset.length === 0) return res.json({ error: "Not found" });
        const p = result.recordset[0];
        res.json({ ...JSON.parse(p.FullDataJSON), PermitID: p.PermitID, Status: p.Status, RenewalsJSON: p.RenewalsJSON, Latitude: p.Latitude, Longitude: p.Longitude });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- RENEWAL LOGIC WITH REJECTION REMARKS ---
app.post('/api/renewal', async (req, res) => {
    try {
        const { PermitID, userRole, userName, action, renewalIndex, rejectionReason, ...data } = req.body;
        const pool = await getConnection();
        const current = await pool.request().input('pid', sql.NVarChar, PermitID).query("SELECT RenewalsJSON, Status, ValidFrom, ValidTo FROM Permits WHERE PermitID = @pid");
        
        let renewals = JSON.parse(current.recordset[0].RenewalsJSON || "[]");
        let status = current.recordset[0].Status;
        const now = getNowIST();

        if (userRole === 'Requester') {
             // ... [Validation Logic E, F, G preserved from previous] ...
             const permitStart = new Date(current.recordset[0].ValidFrom);
             const permitEnd = new Date(current.recordset[0].ValidTo);
             const reqStart = new Date(data.RenewalValidFrom);
             const reqEnd = new Date(data.RenewalValidTill);
             if (reqStart < permitStart || reqEnd > permitEnd) return res.status(400).json({ error: "Renewal must be within original Permit Validity." });
             if (reqStart >= reqEnd) return res.status(400).json({ error: "Invalid Time Range." });
             if (renewals.length > 0) {
                 const lastEnd = new Date(renewals[renewals.length - 1].valid_till);
                 if (reqStart < lastEnd) return res.status(400).json({ error: "Renewal must start after the previous clearance ends." });
             }
             renewals.push({ status: 'pending_review', valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTill, hc: data.RenewalHC, toxic: data.RenewalToxic, oxygen: data.RenewalOxygen, precautions: data.RenewalPrecautions, req_sig: `${userName} on ${now}` });
             status = "Renewal Pending Review";
        } 
        else if (userRole === 'Reviewer') {
            const idx = renewalIndex !== undefined ? renewalIndex : renewals.length - 1;
            const ren = renewals[idx];
            if (action === 'reject') { 
                ren.status = 'rejected'; 
                ren.rev_sig = `${userName} (Rejected)`; 
                ren.rejection_reason = rejectionReason || "No reason provided";
                status = 'Active'; 
            } else { 
                ren.status = 'pending_approval'; 
                ren.rev_sig = `${userName} on ${now}`; 
                status = "Renewal Pending Approval"; 
            }
        }
        else if (userRole === 'Approver') {
            const idx = renewalIndex !== undefined ? renewalIndex : renewals.length - 1;
            const ren = renewals[idx];
            if (action === 'reject') { 
                ren.status = 'rejected'; 
                ren.app_sig = `${userName} (Rejected)`; 
                ren.rejection_reason = rejectionReason || "No reason provided";
                status = 'Active'; 
            } else { 
                ren.status = 'approved'; 
                ren.app_sig = `${userName} on ${now}`; 
                status = "Active"; 
            }
        }

        await pool.request().input('pid', sql.NVarChar, PermitID).input('status', sql.NVarChar, status).input('ren', sql.NVarChar, JSON.stringify(renewals))
            .query("UPDATE Permits SET Status = @status, RenewalsJSON = @ren WHERE PermitID = @pid");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/map-data', async (req, res) => { /* ... map logic ... */ res.json([]); }); 
app.post('/api/stats', async (req, res) => { /* ... stats logic ... */ res.json({success:true, statusCounts:{}, typeCounts:{}}); });

// EXCEL DOWNLOAD (Requirement I)
app.get('/api/download-excel', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query("SELECT * FROM Permits ORDER BY Id DESC");
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Permits');
        worksheet.columns = [
            { header: 'Permit ID', key: 'id', width: 15 }, { header: 'Status', key: 'status', width: 20 },
            { header: 'Work Type', key: 'wt', width: 20 }, { header: 'Requester', key: 'req', width: 25 },
            { header: 'Valid From', key: 'vf', width: 20 }, { header: 'Valid To', key: 'vt', width: 20 }
        ];
        result.recordset.forEach(r => {
            const d = JSON.parse(r.FullDataJSON || "{}");
            worksheet.addRow({ id: r.PermitID, status: r.Status, wt: d.WorkType, req: d.RequesterName, vf: r.ValidFrom, vt: r.ValidTo });
        });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Permits.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send(e.message); }
});

// PDF GENERATION (Strict Grid Format to match Uploaded PDF)
app.get('/api/download-pdf/:id', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('pid', sql.NVarChar, req.params.id).query("SELECT * FROM Permits WHERE PermitID = @pid");
        if(result.recordset.length === 0) return res.status(404).send('Not Found');
        const p = result.recordset[0];
        const d = JSON.parse(p.FullDataJSON);
        const doc = new PDFDocument({ margin: 20, size: 'A4' });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${p.PermitID}.pdf`);
        doc.pipe(res);

        // -- UTILS FOR GRID --
        const drawBox = (x, y, w, h, text, bold=false, bg=null) => {
            if(bg) { doc.rect(x, y, w, h).fill(bg); doc.fillColor('black'); }
            doc.rect(x, y, w, h).stroke();
            if(text) {
                doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
                doc.text(text, x + 2, y + 4, { width: w - 4, align: 'left' });
            }
        };

        const watermark = () => {
            doc.save(); doc.rotate(-45, { origin: [300, 400] });
            const txt = p.Status.includes('Closed') ? 'CLOSED' : 'ACTIVE';
            const col = p.Status.includes('Closed') ? '#ef4444' : '#22c55e';
            doc.fontSize(80).fillColor(col).opacity(0.15).text(txt, 100, 350, {align:'center'});
            doc.restore();
        };

        // PAGE 1
        watermark();
        doc.font('Helvetica-Bold').fontSize(14).text('INDIAN OIL CORPORATION LIMITED', { align: 'center' });
        doc.fontSize(10).text('Pipeline Division', { align: 'center' });
        doc.text('COMPOSITE WORK PERMIT', { align: 'center', underline:true });
        doc.moveDown();

        let y = doc.y;
        // Top Info Grid
        drawBox(20, y, 280, 20, `Type of Work: ${d.WorkType}`, true); drawBox(300, y, 270, 20, `Request No: ${p.PermitID}`, true); y += 20;
        drawBox(20, y, 280, 20, `Applicant: ${d.OfficialName}`); drawBox(300, y, 270, 20, `Description: ${d.Desc}`); y += 20;
        drawBox(20, y, 280, 20, `Location: ${d.ExactLocation} (${d.LocationUnit})`); drawBox(300, y, 270, 20, `Valid: ${new Date(p.ValidFrom).toLocaleString()} to ${new Date(p.ValidTo).toLocaleString()}`); y += 20;
        
        y += 10;
        doc.font('Helvetica-Bold').text('OTHER PERMIT DETAILS', 20, y); y += 15;
        drawBox(20, y, 180, 20, `Vendor: ${d.Vendor||'-'}`); drawBox(200, y, 180, 20, `Ref Iso: ${d.RefIsolationCert||'-'}`); drawBox(380, y, 190, 20, `JSA: ${d.JsaRef||'-'}`); y+=20;
        drawBox(20, y, 180, 20, `CCTV: ${d.CctvAvailable} (${d.CctvDetail||'-'})`); drawBox(200, y, 180, 20, `MOC: ${d.MocRequired} (${d.MocRef||'-'})`); drawBox(380, y, 190, 20, `Dept: ${d.IssuedToDept}`); y+=30;

        // General Checklist Table
        doc.font('Helvetica-Bold').text('GENERAL CHECKLIST', 20, y); y += 15;
        // Header
        drawBox(20, y, 30, 20, 'No', true, '#ddd'); drawBox(50, y, 400, 20, 'Question', true, '#ddd'); drawBox(450, y, 120, 20, 'Status', true, '#ddd'); y += 20;
        
        const gpQs = [
            {id:"GP_Q1", t:"Equipment/Work Area Inspected"}, {id:"GP_Q2", t:"Surrounding Area Cleaned"}, 
            {id:"GP_Q3", t:"Sewer Manhole Covered"}, {id:"GP_Q4", t:"Hazards Considered"}, 
            {id:"GP_Q5", t:`Blinded (Details: ${d.GP_Q5_Detail||'-'})`}, {id:"GP_Q6", t:"Drained & Depressurized"},
            {id:"GP_Q7", t:"Steamed/Purged"}, {id:"GP_Q8", t:"Water Flushed"}, {id:"GP_Q9", t:"Fire Tender Access"},
            {id:"GP_Q10", t:"Iron Sulfide Removed"}, {id:"GP_Q11", t:`Elec Isolated (Permit: ${d.GP_Q11_Detail||'-'})`},
            {id:"GP_Q12", t:`Gas Test (Tox:${d.GP_Q12_ToxicGas} HC:${d.GP_Q12_HC} O2:${d.GP_Q12_Oxygen})`},
            {id:"GP_Q13", t:"Fire Extinguisher Provided"}, {id:"GP_Q14", t:"Area Cordoned Off"}
        ];

        gpQs.forEach((q, i) => {
            drawBox(20, y, 30, 15, `${i+1}`);
            drawBox(50, y, 400, 15, q.t);
            const val = d[q.id] === 'Yes' ? '[X] Yes' : '[ ] NA';
            drawBox(450, y, 120, 15, val);
            y += 15;
        });

        // PAGE 2
        doc.addPage(); watermark(); y = 40;
        doc.font('Helvetica-Bold').text('SPECIFIC CHECKS', 20, y); y += 15;
        
        const spQs = [
            {id:"HW_Q1", t:"Ventilation"}, {id:"HW_Q2", t:"Exit Means"}, {id:"HW_Q3", t:"Standby Person"},
            {id:"HW_Q16", t:`Height Permit (${d.HW_Q16_Detail||'-'})`}, {id:"VE_Q1", t:"Spark Arrestor"}, {id:"EX_Q1", t:"Excavation Clear"}
        ];
        spQs.forEach((q, i) => {
            drawBox(20, y, 30, 15, `${i+1}`);
            drawBox(50, y, 400, 15, q.t);
            const val = d[q.id] === 'Yes' ? '[X] Yes' : '[ ] NA';
            drawBox(450, y, 120, 15, val);
            y += 15;
        });
        y += 20;

        // Hazards & PPE Grid
        drawBox(20, y, 550, 60, ""); 
        doc.text("HAZARDS:", 25, y+5);
        const hazards = ["H_H2S", "H_LackOxygen", "H_Corrosive", "H_ToxicGas", "H_Combustible", "H_Steam", "H_PyroIron", "H_N2Gas", "H_Height", "H_LooseEarth"];
        let hX = 80, hY = y+5;
        hazards.forEach(h => { 
            const box = d[h]==='Y'?'[X]':'[ ]'; 
            doc.text(`${box} ${h.replace('H_','')}`, hX, hY); hX += 80; if(hX>500){hX=80; hY+=15;}
        });
        y += 70;

        drawBox(20, y, 550, 60, "");
        doc.text("PPE:", 25, y+5);
        const ppe = ["P_FaceShield", "P_FreshAirMask", "P_CompressedBA", "P_Goggles", "P_DustRespirator", "P_Earmuff", "P_LifeLine", "P_Apron", "P_SafetyHarness"];
        let pX = 60, pY = y+5;
        ppe.forEach(p => {
            const box = d[p]==='Y'?'[X]':'[ ]';
            doc.text(`${box} ${p.replace('P_','')}`, pX, pY); pX += 100; if(pX>500){pX=60; pY+=15;}
        });
        y += 70;

        drawBox(20, y, 550, 30, `Additional Precautions: ${d.AdditionalPrecautions || '-'}`); y+=40;

        // Signatures
        doc.font('Helvetica-Bold').text('SIGNATURES', 20, y); y+=15;
        drawBox(20, y, 180, 40, `Requester:\n${d.RequesterName}\n${d.RequesterEmail}`);
        drawBox(200, y, 180, 40, `Reviewer:\n${d.Reviewer_Sig||'Pending'}`);
        drawBox(380, y, 190, 40, `Approver:\n${d.Approver_Sig||'Pending'}`);

        // PAGE 3 - Renewals
        doc.addPage(); watermark(); y=40;
        doc.font('Helvetica-Bold').text('CLEARANCE RENEWAL', 20, y); y+=20;
        
        // Renewal Table Header
        drawBox(20, y, 100, 20, "Valid From", true, '#eee'); 
        drawBox(120, y, 100, 20, "Valid To", true, '#eee');
        drawBox(220, y, 150, 20, "Gas Test (HC/Tox/O2)", true, '#eee');
        drawBox(370, y, 200, 20, "Status/Remarks", true, '#eee');
        y+=20;

        const rens = JSON.parse(p.RenewalsJSON || "[]");
        if(rens.length === 0) drawBox(20, y, 550, 20, "No renewals recorded.");
        else {
            rens.forEach(r => {
                drawBox(20, y, 100, 20, r.valid_from.replace('T',' '));
                drawBox(120, y, 100, 20, r.valid_till.replace('T',' '));
                drawBox(220, y, 150, 20, `HC:${r.hc}% Tox:${r.toxic} O2:${r.oxygen}%`);
                let statusTxt = r.status.toUpperCase();
                if(r.rejection_reason) statusTxt += ` (Rej: ${r.rejection_reason})`;
                drawBox(370, y, 200, 20, statusTxt);
                y+=20;
            });
        }

        y+=30;
        doc.font('Helvetica-Bold').text('CLOSURE', 20, y); y+=15;
        drawBox(20, y, 550, 20, `Receiver (Job Done): ${d.Closure_Receiver_Sig || 'Not Signed'}`); y+=20;
        drawBox(20, y, 550, 20, `Issuer (Verified): ${d.Closure_Issuer_Sig || 'Not Signed'}`); y+=20;
        drawBox(20, y, 550, 30, `Closure Remarks: ${d.Closure_Issuer_Remarks || '-'}`);

        doc.end();
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ SYSTEM LIVE ON PORT ${PORT}`));
