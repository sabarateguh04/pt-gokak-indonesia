const fs = require('fs');
const path = require('path');

function getFiles(dir, files = []) {
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const name = dir + '/' + file;
    if (fs.statSync(name).isDirectory()) {
      getFiles(name, files);
    } else {
      if (name.endsWith('.html') && !name.includes('index.html')) {
        files.push(name);
      }
    }
  }
  return files;
}

const files = getFiles(path.join(__dirname, 'public'));

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');

  // Fix early closing of page-body
  content = content.replace(/<div class="page-body">\s*<\/div>/, '<div class="page-body">');
  
  // Close page-body properly before footer
  // _adminty_footer.html starts with </div> then </div> </div> <div id="styleSelector">
  // Since we deleted one </div> (the early one), we must add it back at the end of the content inside page-body.
  // We can insert it right before the modals (which are after page-body).
  // Wait, if we just replace `<div class="page-body">\s*<\/div>`, we actually remove the stray </div>.
  // But wait! If we REMOVE the stray </div>, we are now missing ONE closing tag for the entire document!
  // So we must ADD </div> before the <div class="modal" id="formOverlay"> OR before the <script> tags if no modal.
  if (content.match(/<div class="page-body">\s*<\/div>/)) {
      content = content.replace(/<div class="page-body">\s*<\/div>/, '<div class="page-body">');
      
      // Add closing div for page-body just before scripts or modals
      const injectIndex = content.indexOf('<div class="modal');
      if (injectIndex !== -1) {
          content = content.substring(0, injectIndex) + '</div>\n' + content.substring(injectIndex);
      } else {
          const scriptIndex = content.indexOf('<script src="/js/api.js">');
          if (scriptIndex !== -1) {
              content = content.substring(0, scriptIndex) + '</div>\n' + content.substring(scriptIndex);
          }
      }
  }

  // Restore action buttons into card-header
  if (file.includes('admin/users.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Data Pegawai</h5><button id="btnNew" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Pegawai Baru</button></div>\n<div class="card-block">');
  } else if (file.includes('admin/tasks.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Daftar Tugas</h5><a href="/admin/task-detail" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Buat Tugas</a></div>\n<div class="card-block">');
  } else if (file.includes('admin/pm-schedules.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Jadwal PM</h5><button id="btnNew" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Jadwal Baru</button></div>\n<div class="card-block">');
  } else if (file.includes('admin/pm-parameters.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Parameter Siklus</h5><button id="btnNew" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Parameter Baru</button></div>\n<div class="card-block">');
  } else if (file.includes('admin/mitra.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Daftar Mitra</h5><button id="btnNew" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Mitra Baru</button></div>\n<div class="card-block">');
  } else if (file.includes('leader/tasks.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Tugas Line</h5><a href="/leader/task-detail" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Buat Tugas</a></div>\n<div class="card-block">');
  } else if (file.includes('leader/pm-schedules.html')) {
      content = content.replace(/<div class="card"[^>]*>\s*<div class="card-block">/, '<div class="card">\n<div class="card-header"><h5>Jadwal PM Line</h5><button id="btnNew" class="btn btn-primary btn-sm" style="float:right"><i class="feather icon-plus"></i> Jadwal Baru</button></div>\n<div class="card-block">');
  }

  // Ensure button in master.html are bootstrap
  if (file.includes('admin/master.html')) {
      content = content.replace(/<button onclick="openForm/g, '<button class="btn btn-primary btn-sm" onclick="openForm');
      content = content.replace(/class="btn secondary"/g, 'class="btn btn-default btn-sm"');
  }

  fs.writeFileSync(file, content);
}

console.log('Fixed body layouts and restored action buttons.');
