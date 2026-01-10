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
let containerClient;
if (AZURE_CONN_STR) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN_STR);
        containerClient = blobServiceClient.getContainerClient("permit-attachments");
        (async () => { try { await containerClient.createIfNotExists(); } catch(e) {} })();
    } catch (err) { console.error("Blob Storage Error:", err.message); }
}
const upload = multer({ storage: multer.memoryStorage() });

// --- HELPERS ---
function getNowIST() { 
    return new Date().toLocaleString("en-GB", { 
        timeZone: "Asia/Kolkata", 
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
    }).replace(',', ''); 
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr; 
    return d.toLocaleString("en-GB", { 
        day: '2-digit', month: '2-digit', year: 'numeric', 
        hour: '2-digit', minute: '2-digit', hour12: false 
    }).replace(',', '');
}

// --- CHECKLIST DATA ---
const CHECKLIST_DATA = {
    A: [
        "1. Equipment / Work Area inspected.",
        "2. Surrounding area checked, cleaned and covered. Oil/RAGS/Grass Etc removed.",
        "3. Manholes, Sewers, CBD etc. and hot nearby surface covered.",
        "4. Considered hazards from other routine, non-routine operations and concerned person alerted.",
        "5. Equipment blinded/ disconnected/ closed/ isolated/ wedge opened.",
        "6. Equipment properly drained and depressurized.",
        "7. Equipment properly steamed/purged.",
        "8. Equipment water flushed.",
        "9. Access for Free approach of Fire Tender.",
        "10. Iron Sulfide removed/ Kept wet.",
        "11. Equipment electrically isolated and tagged vide Permit no.",
        "12. Gas Test: HC / Toxic / O2 checked.",
        "13. Running water hose / Fire extinguisher provided. Fire water system available.",
        "14. Area cordoned off and Precautionary tag/Board provided.",
        "15. CCTV monitoring facility available at site.",
        "16. Proper ventilation and Lighting provided."
    ],
    B: [
        "1. Proper means of exit / escape provided.",
        "2. Standby personnel provided from Mainline/ Maint. / Contractor/HSE.",
        "3. Checked for oil and Gas trapped behind the lining in equipment.",
        "4. Shield provided against spark.",
        "5. Portable equipment / nozzle properly grounded.",
        "6. Standby persons provided for entry to confined space.",
        "7. Adequate Communication Provided to Stand by Person.",
        "8. Attendant Trained Provided With Rescue Equipment/SCBA.",
        "9. Space Adequately Cooled for Safe Entry Of Person.",
        "10. Continuous Inert Gas Flow Arranged.",
        "11. Check For Earthing/ELCB of all Temporary Electrical Connections being used for welding.",
        "12. Gas Cylinders are kept outside the confined Space.",
        "13. Spark arrestor Checked on mobile Equipments.",
        "14. Welding Machine Checked for Safe Location.",
        "15. Permit taken for working at height Vide Permit No."
    ],
    C: [
        "1. PESO approved spark elimination system provided on the mobile equipment/ vehicle provided."
    ],
    D: [
        "1. For excavated trench/ pit proper slop/ shoring/ shuttering provided to prevent soil collapse.",
        "2. Excavated soil kept at safe distance from trench/pit edge (min. pit depth).",
        "3. Safe means of access provided inside trench/pit.",
        "4. Movement of heavy vehicle prohibited."
    ]
};

// --- PDF DRAWING ---
function drawHeader(doc, bgColor) {
    // Background Color
    if(bgColor && bgColor !== 'Auto' && bgColor !== 'White') {
        const colorMap = { 'Red': '#fee2e2', 'Green': '#dcfce7', 'Yellow': '#fef9c3' };
        doc.save();
        doc.fillColor(colorMap[bgColor] || 'white');
        doc.rect(0, 0, doc.page.width, doc.page.height).fill();
        doc.restore();
    }

    const startX=30, startY=30; doc.lineWidth(1);
    doc.rect(startX,startY,535,95).stroke();
    doc.rect(startX,startY,80,95).stroke();
    doc.rect(startX+80,startY,320,95).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('INDIAN OIL CORPORATION LIMITED', startX+80, startY+15, {width:320, align:'center'});
    doc.fontSize(10).text('EASTERN REGION PIPELINES', startX+80, startY+30, {width:320, align:'center'});
    doc.text('HSE DEPT.', startX+80, startY+45, {width:320, align:'center'});
    doc.fontSize(9).text('COMPOSITE WORK PERMIT (OISD-105)', startX+80, startY+65, {width:320, align:'center'});
    doc.rect(startX+400,startY,135,95).stroke();
    doc.fontSize(8).font('Helvetica');
    doc.text('Doc No: ERPL/HS&E/25-26', startX+405, startY+60);
    doc.text('Issue No: 01', startX+405, startY+70);
    doc.text('Date: 01.09.2025', startX+405, startY+80);
}

// --- API ROUTES ---

// 1. LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const pool = await getConnection();
        const r = await pool.request().input('r', sql.NVarChar, req.body.role).input('e', sql.NVarChar, req.body.name).input('p', sql.NVarChar, req.body.password).query('SELECT * FROM Users WHERE Role=@r AND Email=@e AND Password=@p');
        if(r.recordset.length > 0) {
            const u = r.recordset[0];
            res.json({success:true, user:{ Name: u.Name||u.name, Email: u.Email||u.email, Role: u.Role||u.role }});
        } else res.json({success:false});
    } catch(e){res.status(500).json({error:e.message})} 
});

// 2. USERS
app.get('/api/users', async (req, res) => {
    try {
        const pool = await getConnection();
        const r = await pool.request().query('SELECT Name, Email, Role FROM Users');
        const mapU = u => ({name: u.Name, email: u.Email, role: u.Role});
        res.json({
            Requesters: r.recordset.filter(u=>u.Role==='Requester').map(mapU),
            Reviewers: r.recordset.filter(u=>u.Role==='Reviewer').map(mapU),
            Approvers: r.recordset.filter(u=>u.Role==='Approver').map(mapU)
        });
    } catch(e){res.status(500).json({error:e.message})} 
});

// 3. WORKER MANAGEMENT (Updated for Edits/Delete)
app.post('/api/save-worker', async (req, res) => {
    try {
        const { WorkerID, Action, Role, Details, RequestorEmail } = req.body;
        const pool = await getConnection();

        // VALIDATION
        if ((Action === 'create' || Action === 'edit_request') && Details) {
             if (parseInt(Details.Age) < 18) return res.status(400).json({error: "Worker must be 18+"});
        }

        if (Action === 'create') {
            const idRes = await pool.request().query("SELECT TOP 1 WorkerID FROM Workers ORDER BY WorkerID DESC");
            const wid = `W-${parseInt(idRes.recordset.length > 0 ? idRes.recordset[0].WorkerID.split('-')[1] : 1000) + 1}`;
            // For new worker, PendingData IS the data
            const dataObj = { Current: {}, Pending: Details };
            await pool.request().input('w', wid).input('s', 'Pending Review').input('r', RequestorEmail).input('j', JSON.stringify(dataObj))
                .query("INSERT INTO Workers (WorkerID, Status, RequestorEmail, DataJSON) VALUES (@w, @s, @r, @j)");
            res.json({success:true});
        } 
        else if (Action === 'edit_request') {
            // Fetch current, update pending
            const cur = await pool.request().input('w', WorkerID).query("SELECT DataJSON FROM Workers WHERE WorkerID=@w");
            if(cur.recordset.length === 0) return res.status(404).json({error:"Worker not found"});
            let dataObj = JSON.parse(cur.recordset[0].DataJSON);
            
            // Retain immutable fields from Current, overwrite editable from Details
            const newPending = { ...dataObj.Current, ...Details }; // Overwrite with new Address, Age, ID
            dataObj.Pending = newPending;
            
            await pool.request().input('w', WorkerID).input('s', 'Edit Pending Review').input('j', JSON.stringify(dataObj))
                .query("UPDATE Workers SET Status=@s, DataJSON=@j WHERE WorkerID=@w");
            res.json({success:true});
        }
        else if (Action === 'delete') {
            await pool.request().input('w', WorkerID).query("DELETE FROM Workers WHERE WorkerID=@w");
            res.json({success:true});
        }
        else {
            // APPROVAL FLOW (Review/Approve/Reject)
            const cur = await pool.request().input('w', WorkerID).query("SELECT Status, DataJSON FROM Workers WHERE WorkerID=@w");
            if(cur.recordset.length === 0) return res.status(404).json({error:"Worker not found"});
            let st = cur.recordset[0].Status;
            let dataObj = JSON.parse(cur.recordset[0].DataJSON);

            let nextSt = st;
            if (Action === 'approve') {
                if (st.includes('Pending Review')) nextSt = st.replace('Review', 'Approval');
                else if (st.includes('Pending Approval')) {
                    nextSt = 'Approved';
                    // PROMOTE Pending -> Current
                    dataObj.Current = dataObj.Pending;
                    dataObj.Pending = null; 
                }
            } else if (Action === 'reject') {
                nextSt = 'Rejected';
                dataObj.Pending = null; // Clear changes on rejection? Or keep for history. Clearing for now.
            }

            await pool.request().input('w', WorkerID).input('s', nextSt).input('j', JSON.stringify(dataObj))
                .query("UPDATE Workers SET Status=@s, DataJSON=@j WHERE WorkerID=@w");
            res.json({success:true});
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/get-workers', async (req, res) => {
    try {
        const pool = await getConnection();
        const r = await pool.request().query("SELECT * FROM Workers");
        const list = r.recordset.map(w => {
            const d = JSON.parse(w.DataJSON);
            // If Pending exists, show pending details for review, otherwise current
            const details = d.Pending || d.Current || {};
            return { ...details, WorkerID: w.WorkerID, Status: w.Status, RequestorEmail: w.RequestorEmail, IsEdit: w.Status.includes('Edit') };
        });
        
        if(req.body.context === 'permit_dropdown') {
            // STRICT REQUIREMENT: Only show if Status is 'Approved'. Any pending edit hides them.
            res.json(list.filter(w => w.Status === 'Approved' && w.RequestorEmail === req.body.email));
        } else {
            // Dashboard: Show all
            if(req.body.role === 'Requester') res.json(list.filter(w => w.RequestorEmail === req.body.email));
            else res.json(list);
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});

// 4. PERMIT DASHBOARD
app.post('/api/dashboard', async (req, res) => {
    try {
        const pool = await getConnection();
        const r = await pool.request().query("SELECT PermitID, Status, ValidFrom, ValidTo, RequesterEmail, ReviewerEmail, ApproverEmail, FullDataJSON FROM Permits");
        const p = r.recordset.map(x=>({...JSON.parse(x.FullDataJSON), PermitID:x.PermitID, Status:x.Status, ValidFrom:x.ValidFrom}));
        const f = p.filter(x => (req.body.role==='Requester'?x.RequesterEmail===req.body.email : true));
        res.json(f.sort((a,b)=>b.PermitID.localeCompare(a.PermitID)));
    } catch(e){res.status(500).json({error:e.message})} 
});

// 5. SAVE PERMIT
app.post('/api/save-permit', upload.single('file'), async (req, res) => {
    try {
        const vf = new Date(req.body.ValidFrom); const vt = new Date(req.body.ValidTo);
        if ((vt-vf)/(1000*60*60*24) > 7) return res.status(400).json({ error: "Max 7 days allowed" });
        const pool = await getConnection();
        let pid = req.body.PermitID;
        if (!pid || pid === 'undefined' || pid === 'null') {
            const idRes = await pool.request().query("SELECT TOP 1 PermitID FROM Permits ORDER BY Id DESC");
            pid = `WP-${parseInt(idRes.recordset.length > 0 ? idRes.recordset[0].PermitID.split('-')[1] : 1000) + 1}`;
        }
        const chk = await pool.request().input('p', pid).query("SELECT Status FROM Permits WHERE PermitID=@p");
        if(chk.recordset.length > 0 && chk.recordset[0].Status !== 'Pending Review' && chk.recordset[0].Status !== 'New') { return res.status(400).json({error:"Cannot edit active permit"}); }
        const data = { ...req.body, PermitID: pid };
        const q = pool.request().input('p', pid).input('s', 'Pending Review').input('w', req.body.WorkType).input('re', req.body.RequesterEmail).input('rv', req.body.ReviewerEmail).input('ap', req.body.ApproverEmail).input('vf', vf).input('vt', vt).input('j', JSON.stringify(data));
        if (chk.recordset.length > 0) await q.query("UPDATE Permits SET FullDataJSON=@j, WorkType=@w, ValidFrom=@vf, ValidTo=@vt WHERE PermitID=@p");
        else await q.query("INSERT INTO Permits (PermitID, Status, WorkType, RequesterEmail, ReviewerEmail, ApproverEmail, ValidFrom, ValidTo, FullDataJSON, RenewalsJSON) VALUES (@p, @s, @w, @re, @rv, @ap, @vf, @vt, @j, '[]')");
        res.json({ success: true, permitId: pid });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. RENEWAL
app.post('/api/renewal', async (req, res) => {
    try {
        const { PermitID, userRole, userName, action, rejectionReason, ...data } = req.body;
        const pool = await getConnection();
        const cur = await pool.request().input('p', PermitID).query("SELECT RenewalsJSON, Status, ValidFrom, ValidTo FROM Permits WHERE PermitID=@p");
        let r = JSON.parse(cur.recordset[0].RenewalsJSON||"[]"); 
        const now = getNowIST();
        if (userRole === 'Requester') {
             r.push({ status: 'pending_review', valid_from: data.RenewalValidFrom, valid_till: data.RenewalValidTo, hc: data.hc, toxic: data.toxic, oxygen: data.oxygen, precautions: data.precautions, req_name: userName, req_at: now });
        } else {
            const last = r[r.length-1];
            if (action === 'reject') { last.status = 'rejected'; last.rej_by = userName; last.rej_at = now; last.rej_reason = rejectionReason; }
            else { 
                last.status = userRole==='Reviewer'?'pending_approval':'approved'; 
                if(userRole==='Reviewer') { last.rev_name = userName; last.rev_at = now; last.rev_rem = rejectionReason; }
                if(userRole==='Approver') { last.app_name = userName; last.app_at = now; last.app_rem = rejectionReason; }
            }
        }
        let newStatus = r[r.length-1].status==='approved'?'Active':(r[r.length-1].status==='rejected'?'Active':(userRole==='Requester'?'Renewal Pending Review':'Renewal Pending Approval'));
        await pool.request().input('p', PermitID).input('r', JSON.stringify(r)).input('s', newStatus).query("UPDATE Permits SET RenewalsJSON=@r, Status=@s WHERE PermitID=@p");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. STATUS UPDATE
app.post('/api/update-status', async (req, res) => {
    try {
        const { PermitID, action, role, user, comment, bgColor, ...extras } = req.body;
        const pool = await getConnection();
        const cur = await pool.request().input('p', PermitID).query("SELECT * FROM Permits WHERE PermitID=@p");
        let d = JSON.parse(cur.recordset[0].FullDataJSON);
        Object.assign(d, extras);
        if(bgColor) d.PdfBgColor = bgColor;
        
        let st = cur.recordset[0].Status;
        const now = getNowIST();

        if(action==='reject') { st='Rejected'; }
        else if(role==='Reviewer' && action==='review') { st='Pending Approval'; d.Reviewer_Sig=`${user} on ${now}`; }
        else if(role==='Approver' && action==='approve') { st = st.includes('Closure') ? 'Closed' : 'Active'; if(st==='Closed') d.Closure_Issuer_Sig=`${user} on ${now}`; else d.Approver_Sig=`${user} on ${now}`; }
        else if(action==='initiate_closure') { st='Closure Pending Review'; d.Closure_Requestor_Date=now; d.Closure_Receiver_Sig=`${user} on ${now}`; }
        else if(action==='reject_closure') { st='Active'; }
        else if(action==='approve_closure') { st = 'Closure Pending Approval'; d.Closure_Reviewer_Sig=`${user} on ${now}`; d.Closure_Reviewer_Date=now; }
        
        await pool.request().input('p', PermitID).input('s', st).input('j', JSON.stringify(d)).query("UPDATE Permits SET Status=@s, FullDataJSON=@j WHERE PermitID=@p");
        res.json({success:true});
    } catch(e){res.status(500).json({error:e.message})} 
});

app.post('/api/permit-data', async (req, res) => { try { const pool = await getConnection(); const r = await pool.request().input('p', sql.NVarChar, req.body.permitId).query("SELECT * FROM Permits WHERE PermitID=@p"); if(r.recordset.length) res.json({...JSON.parse(r.recordset[0].FullDataJSON), Status:r.recordset[0].Status, RenewalsJSON:r.recordset[0].RenewalsJSON, FullDataJSON:null}); else res.json({error:"404"}); } catch(e){res.status(500).json({error:e.message})} });
app.post('/api/map-data', async (req, res) => { try { const pool = await getConnection(); const r = await pool.request().query("SELECT PermitID, FullDataJSON, Latitude, Longitude FROM Permits WHERE Status='Active'"); res.json(r.recordset.map(x=>({PermitID:x.PermitID, lat:parseFloat(x.Latitude), lng:parseFloat(x.Longitude), ...JSON.parse(x.FullDataJSON)}))); } catch(e){res.status(500).json({error:e.message})} });
app.post('/api/stats', async (req, res) => { try { const pool = await getConnection(); const r = await pool.request().query("SELECT Status, WorkType FROM Permits"); const s={}, t={}; r.recordset.forEach(x=>{s[x.Status]=(s[x.Status]||0)+1; t[x.WorkType]=(t[x.WorkType]||0)+1;}); res.json({success:true, statusCounts:s, typeCounts:t}); } catch(e){res.status(500).json({error:e.message})} });

// 8. PDF GENERATION
app.get('/api/download-pdf/:id', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('p', req.params.id).query("SELECT * FROM Permits WHERE PermitID = @p");
        if(!result.recordset.length) return res.status(404).send('Not Found');
        const p = result.recordset[0]; const d = JSON.parse(p.FullDataJSON);
        const doc = new PDFDocument({ margin: 30, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename=${p.PermitID}.pdf`); doc.pipe(res);
        
        const bgColor = d.PdfBgColor || 'White';

        // Header
        drawHeader(doc, bgColor); doc.y = 135; doc.fontSize(9).font('Helvetica');
        const infoY = doc.y; const c1 = 40, c2 = 300;
        doc.text(`Permit No: ${p.PermitID}`, c1, infoY).text(`Validity: ${formatDate(p.ValidFrom)} - ${formatDate(p.ValidTo)}`, c2, infoY);
        doc.text(`Issued To: ${d.IssuedToDept} (${d.Vendor})`, c1, infoY+15).text(`Location: ${d.ExactLocation}`, c2, infoY+15);
        doc.text(`Desc: ${d.Desc}`, c1, infoY+30,{width:500}).text(`Site Person: ${d.RequesterName}`, c1, infoY+60).text(`Security: ${d.SecurityGuard||'-'}`, c2, infoY+60);
        doc.text(`Emergency: ${d.EmergencyContact||'-'}`, c1, infoY+75).text(`Fire Stn: ${d.FireStation||'-'}`, c2, infoY+75);
        doc.rect(30,infoY-5,535,95).stroke(); doc.y=infoY+100;

        // Checklists
        const drawChecklist = (t,i,pr) => { 
            if(doc.y>650){doc.addPage(); drawHeader(doc, bgColor); doc.y=135;} 
            doc.font('Helvetica-Bold').text(t,30,doc.y+10); doc.y+=25; 
            let y=doc.y; doc.rect(30,y,350,20).stroke().text("Item",35,y+5); doc.rect(380,y,60,20).stroke().text("Sts",385,y+5); doc.rect(440,y,125,20).stroke().text("Rem",445,y+5); y+=20;
            doc.font('Helvetica').fontSize(8);
            i.forEach((x,k)=>{
                if(y>750){doc.addPage(); drawHeader(doc, bgColor); doc.y=135; y=135;}
                const st = d[`${pr}_Q${k+1}`]||'NA';
                if(d[`${pr}_Q${k+1}`]) {
                    doc.rect(30,y,350,20).stroke().text(x,35,y+5,{width:340});
                    doc.rect(380,y,60,20).stroke().text(st,385,y+5);
                    doc.rect(440,y,125,20).stroke().text(d[`${pr}_Q${k+1}_Detail`]||'',445,y+5); y+=20;
                }
            }); doc.y=y;
        };
        drawChecklist("SECTION A", CHECKLIST_DATA.A,'A'); drawChecklist("SECTION B", CHECKLIST_DATA.B,'B'); drawChecklist("SECTION C", CHECKLIST_DATA.C,'C'); drawChecklist("SECTION D", CHECKLIST_DATA.D,'D');

        // Hazards
        if(doc.y>650){doc.addPage(); drawHeader(doc, bgColor); doc.y=135;}
        doc.font('Helvetica-Bold').text("HAZARDS & PRECAUTIONS",30,doc.y); doc.y+=15; doc.rect(30,doc.y,535,60).stroke();
        const hazKeys = ["Lack of Oxygen", "H2S", "Toxic Gases", "Combustible gases", "Pyrophoric Iron", "Corrosive Chemicals", "cave in formation"];
        const foundHaz = hazKeys.filter(k => d[`H_${k.replace(/ /g,'')}`] === 'Y'); if(d.H_Others==='Y') foundHaz.push(`Others: ${d.H_Others_Detail}`);
        doc.text(`Hazards: ${foundHaz.join(', ')}`,35,doc.y+5); 
        const ppeKeys = ["Helmet","Safety Shoes","Hand gloves","Boiler suit","Face Shield","Apron","Goggles","Dust Respirator","Fresh Air Mask","Lifeline","Safety Harness","Airline","Earmuff"];
        const foundPPE = ppeKeys.filter(k => d[`P_${k.replace(/ /g,'')}`] === 'Y');
        doc.text(`PPE: ${foundPPE.join(', ')}`,35,doc.y+25); doc.y+=70;

        // Workers Table (NEW)
        if(doc.y>650){doc.addPage(); drawHeader(doc, bgColor); doc.y=135;}
        doc.font('Helvetica-Bold').text("WORKERS DEPLOYED",30,doc.y); doc.y+=15; 
        let wy = doc.y;
        doc.rect(30,wy,150,20).stroke().text("Name",35,wy+5); doc.rect(180,wy,50,20).stroke().text("Gender",185,wy+5); doc.rect(230,wy,40,20).stroke().text("Age",235,wy+5); doc.rect(270,wy,200,20).stroke().text("Contractor",275,wy+5); wy+=20;
        const workers = d.SelectedWorkers || [];
        doc.font('Helvetica').fontSize(8);
        workers.forEach(w => {
            doc.rect(30,wy,150,20).stroke().text(w.Name,35,wy+5);
            doc.rect(180,wy,50,20).stroke().text(w.Gender,185,wy+5);
            doc.rect(230,wy,40,20).stroke().text(w.Age,235,wy+5);
            doc.rect(270,wy,200,20).stroke().text(d.RequesterName,275,wy+5);
            wy+=20;
        });
        doc.y = wy+20;

        // Signatures
        doc.font('Helvetica-Bold').text("SIGNATURES",30,doc.y); doc.y+=15; const sY=doc.y;
        doc.rect(30,sY,178,40).stroke().text(`REQ: ${d.RequesterName}`,35,sY+5);
        doc.rect(208,sY,178,40).stroke().text(`REV: ${d.Reviewer_Sig||'-'}`,213,sY+5);
        doc.rect(386,sY,179,40).stroke().text(`APP: ${d.Approver_Sig||'-'}`,391,sY+5); doc.y=sY+50;

        // Renewals
        doc.font('Helvetica-Bold').text("CLEARANCE RENEWAL",30,doc.y); doc.y+=15;
        let ry = doc.y;
        doc.rect(30,ry,60,25).stroke().text("From",32,ry+5); doc.rect(90,ry,60,25).stroke().text("To",92,ry+5); doc.rect(150,ry,100,25).stroke().text("Gas (HC/Tox/O2)",152,ry+5); doc.rect(250,ry,100,25).stroke().text("Precautions",252,ry+5); doc.rect(350,ry,70,25).stroke().text("Req",352,ry+5); doc.rect(420,ry,70,25).stroke().text("Rev",422,ry+5); doc.rect(490,ry,75,25).stroke().text("App",492,ry+5); ry+=25;
        const renewals = JSON.parse(p.RenewalsJSON || "[]");
        doc.font('Helvetica').fontSize(8);
        renewals.forEach(r => {
             if(ry>700){doc.addPage(); drawHeader(doc, bgColor); doc.y=135; ry=135;}
             doc.rect(30,ry,60,35).stroke().text(r.valid_from.replace('T','\n'), 32, ry+5);
             doc.rect(90,ry,60,35).stroke().text(r.valid_till.replace('T','\n'), 92, ry+5);
             doc.rect(150,ry,100,35).stroke().text(`${r.hc}/${r.toxic}/${r.oxygen}`, 152, ry+5);
             doc.rect(250,ry,100,35).stroke().text(r.precautions||'-', 252, ry+5);
             doc.rect(350,ry,70,35).stroke().text(`${r.req_name}\n${r.req_at}`, 352, ry+5);
             doc.rect(420,ry,70,35).stroke().text(`${r.rev_name||'-'}\n${r.rev_at||'-'}`, 422, ry+5);
             doc.rect(490,ry,75,35).stroke().text(`${r.app_name||'-'}\n${r.app_at||'-'}`, 492, ry+5);
             ry += 35;
        });
        doc.y = ry + 20;

        // Closure
        if(doc.y>650){doc.addPage(); drawHeader(doc, bgColor); doc.y=135;}
        doc.font('Helvetica-Bold').text("CLOSURE OF WORK PERMIT",30,doc.y); doc.y+=15;
        let cy = doc.y;
        doc.rect(30,cy,80,20).stroke().text("Stage",35,cy+5); doc.rect(110,cy,120,20).stroke().text("Name/Sig",115,cy+5); doc.rect(230,cy,100,20).stroke().text("Date/Time",235,cy+5); doc.rect(330,cy,235,20).stroke().text("Remarks",335,cy+5); cy+=20;
        const closureSteps = [
            {role:'Requestor', name:d.RequesterName, date:d.Closure_Requestor_Date, rem:d.Closure_Requestor_Remarks},
            {role:'Reviewer', name:d.Reviewer_Sig, date:d.Closure_Reviewer_Date, rem:d.Closure_Reviewer_Remarks},
            {role:'Approver', name:d.Closure_Issuer_Sig, date:d.Closure_Approver_Date, rem:d.Closure_Approver_Remarks}
        ];
        doc.font('Helvetica').fontSize(8);
        closureSteps.forEach(s => {
             doc.rect(30,cy,80,30).stroke().text(s.role,35,cy+5);
             doc.rect(110,cy,120,30).stroke().text(s.name||'-',115,cy+5);
             doc.rect(230,cy,100,30).stroke().text(s.date||'-',235,cy+5);
             doc.rect(330,cy,235,30).stroke().text(s.rem||'-',335,cy+5);
             cy+=30;
        });
        
        // Watermark
        const wm = p.Status.includes('Closed') ? 'CLOSED' : 'ACTIVE';
        const color = p.Status.includes('Closed') ? '#ef4444' : '#22c55e';
        const range = doc.bufferedPageRange();
        for(let i=0; i<range.count; i++) {
            doc.switchToPage(i); doc.save(); doc.rotate(-45, {origin:[300,400]}); 
            doc.fontSize(80).fillColor(color).opacity(0.15).text(wm, 100, 350, {align:'center'}); doc.restore();
        }
        doc.end();
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(8080, () => console.log('Server Ready'));
