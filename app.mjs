import {FIELDS,cleanField,extractFields,extractMeasurements,pageNumbers,idMatch} from './parser.mjs';
import {pdfFor,renderPage,readPage,releaseDocument,setProgress} from './engine.mjs';
const $=id=>document.getElementById(id),docs=[];let busy=false,cancelled=false,current=null,page=1,rect=null,drag=null,dirty=false,sort=1,toastTimer,xlsxPromise;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={pending:'대기',review:'검토필요',confirmed:'확정',error:'오류'};
function toast(message){const el=$('toast');clearTimeout(toastTimer);el.textContent=message;el.hidden=false;($('review').open?$('review'):document.body).append(el);toastTimer=setTimeout(()=>el.hidden=true,6000);}
function progress(text,value=0){$('progressBox').hidden=false;$('progressText').textContent=text;$('progress').value=Math.round(value*100);$('progressNumber').textContent=Math.round(value*100)+'%';if($('review').open)$('regionHint').textContent=text+' · '+Math.round(value*100)+'%';}
setProgress((text,value)=>progress(text,value));
function visible(){const q=$('search').value.toLowerCase();return docs.filter(d=>($('status').value==='all'||d.status===$('status').value)&&(!q||(d.name+' '+Object.values(d.fields).join(' ')).toLowerCase().includes(q))).sort((a,b)=>sort*a.name.localeCompare(b.name,'ko',{numeric:true}));}
function selected(){return docs.filter(d=>d.checked);}
function render(){
  $('total').textContent=docs.length;$('reviewCount').textContent=docs.filter(d=>d.status==='review').length;$('confirmedCount').textContent=docs.filter(d=>d.status==='confirmed').length;
  const list=visible();$('empty').hidden=!!list.length;$('documents').innerHTML=list.map(d=>`<tr><td><input type="checkbox" aria-label="${escape(d.name)} 선택" data-check="${d.id}" ${d.checked?'checked':''} ${busy?'disabled':''}></td><td>${escape(d.name)}<small>${escape(d.error||`${d.pages||'?'}페이지 · ${d.engine||'추출 대기'}`)}</small></td><td>${escape(d.fields.certificate_number||'—')}</td><td>${escape(d.fields.instrument_number||'—')} ${d.fields.instrument_number?`<span class="badge ${idMatch(d.name,d.fields.instrument_number)==='OK'?'ok':''}">${idMatch(d.name,d.fields.instrument_number)}</span>`:''}</td><td><span class="badge ${d.status}">${labels[d.status]}</span></td><td><button data-open="${d.id}" ${busy?'disabled':''}>검토</button></td></tr>`).join('');
  $('all').checked=!!list.length&&list.every(d=>d.checked);$('all').indeterminate=list.some(d=>d.checked)&&!$('all').checked;$('all').disabled=busy||!list.length;
  $('selectionCount').textContent=selected().length+'개 선택';
  for(const id of ['choose','restore','pages','regionField','closeReview','prev','next','saveDraft','addRow'])$(id).disabled=busy;
  $('save').disabled=busy||!docs.length;$('remove').disabled=busy||!selected().length;$('extract').disabled=busy||!selected().some(d=>d.file);$('export').disabled=busy||!selected().some(d=>d.status==='confirmed');
  $('readRegion').disabled=busy||!rect||!current?.file;$('cancel').hidden=!busy;document.body.classList.toggle('busy',busy);
}
async function run(fn){if(busy)return;busy=true;cancelled=false;render();try{await fn();}catch(e){toast(e.message||'작업을 완료하지 못했습니다.');}finally{busy=false;$('progressBox').hidden=true;render();}}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
async function addFiles(files){await run(async()=>{
  for(const file of [...files]){
    if(!/\.pdf$/i.test(file.name)||file.size>30*1024**2){toast(file.name+': 30MB 이하 PDF를 선택하세요.');continue;}
    const buffer=await file.arrayBuffer(),id=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');
    const existing=docs.find(d=>d.id===id);if(existing){existing.file=file;existing.checked=true;continue;}
    if(docs.length>=20||docs.reduce((a,d)=>a+(d.file?.size||0),0)+file.size>200*1024**2){toast('한 작업은 최대 20개, 합계 200MB입니다. 완료된 문서를 저장 후 삭제하세요.');break;}
    docs.push({id,name:file.name,file,status:'pending',fields:Object.fromEntries(FIELDS.map(([key])=>[key,''])),rows:[],lines:[],regions:{},checked:true});
  }
});}
$('choose').onclick=()=>$('files').click();$('files').onchange=async e=>{await addFiles(e.target.files);e.target.value='';};
$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('drag');};$('drop').ondragleave=()=>$('drop').classList.remove('drag');$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('drag');if(!busy)addFiles(e.dataTransfer.files);};
document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());
$('documents').onchange=e=>{const d=docs.find(d=>d.id===e.target.dataset.check);if(d){d.checked=e.target.checked;render();}};
$('documents').onclick=e=>{const id=e.target.closest('[data-open]')?.dataset.open;if(id)openReview(docs.find(d=>d.id===id));};
$('all').onchange=e=>{visible().forEach(d=>d.checked=e.target.checked);render();};$('status').onchange=render;$('search').oninput=render;$('sortName').onclick=()=>{sort*=-1;render();};
$('extract').onclick=()=>run(async()=>{
  const targets=selected().filter(d=>d.file);
  if(targets.some(d=>d.status==='confirmed'||d.edited)&&!confirm('직접 수정·확정한 값을 새 추출 결과로 바꿀까요?'))return;
  for(let i=0;i<targets.length&&!cancelled;i++){
    const doc=targets[i];try{
      const pdf=await pdfFor(doc),pages=pageNumbers($('pages').value,pdf.numPages);const lines=[];
      for(const n of pages){if(cancelled)break;progress(`${doc.name} · ${n}/${pdf.numPages}페이지`,i/targets.length);lines.push(...await readPage(doc,n));}
      if(cancelled){toast('중단했습니다. 이전 추출 결과는 유지됩니다.');break;}
      const result=extractFields(lines);doc.fields=result.fields;doc.sources=result.sources;doc.rows=extractMeasurements(lines);doc.lines=lines;doc.status='review';doc.edited=false;doc.error='';doc.engine=[...new Set(lines.map(l=>l.engine))].join(' + ')||'읽은 글자 없음';
    }catch(e){doc.status='error';doc.error=e.message;}
    render();
  }
});
$('cancel').onclick=()=>{cancelled=true;progress('현재 페이지가 끝나면 중단합니다.');};
$('remove').onclick=()=>run(async()=>{const targets=selected();if(!confirm(`선택한 ${targets.length}개 문서를 이 작업에서 삭제할까요? 원본 PDF 파일은 그대로 남습니다.`))return;for(const d of targets){await releaseDocument(d.id);docs.splice(docs.indexOf(d),1);}});
function view(help){$('helpView').hidden=!help;$('workView').hidden=help;$('navHelp').classList.toggle('active',help);$('navWork').classList.toggle('active',!help);$('crumb').textContent=help?'사용 안내':'문서작업';}
$('navHelp').onclick=()=>view(true);$('navWork').onclick=()=>view(false);
$('regionField').innerHTML=FIELDS.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')+'<option value="measurements">측정점 + 측정값 표</option>';
function form(){
  $('fields').innerHTML=FIELDS.map(([key,label])=>`<label>${label}<input name="${key}" value="${escape(current.fields[key])}" autocomplete="off" aria-label="${label}"></label>`).join('');
  $('measurements').innerHTML='';current.rows.forEach(addRow);$('raw').textContent=current.lines.map(l=>`${l.page}p · ${l.text}`).join('\n');updateBadge();
}
function addRow(row={}){const tr=document.createElement('tr');tr.innerHTML=['point','value','unit','type'].map((key,i)=>`<td><input data-row="${key}" aria-label="${['측정점','측정값','단위','측정 구분'][i]}" value="${escape(row[key]||'')}"></td>`).join('')+'<td><button type="button" aria-label="측정행 삭제">×</button></td>';tr.querySelector('button').onclick=()=>{tr.remove();dirty=true;};$('measurements').append(tr);}
function updateBadge(){const value=$('fields').querySelector('[name=instrument_number]')?.value||'';const match=idMatch(current.name,value);$('idBadge').textContent='관리번호 '+match;$('idBadge').className='badge '+(match==='OK'?'ok':'');}
function saveForm(confirmResult=false){
  current.fields=Object.fromEntries(FIELDS.map(([key])=>[key,$('fields').querySelector(`[name=${key}]`).value.trim()]));
  current.rows=[...$('measurements').children].map(tr=>Object.fromEntries([...tr.querySelectorAll('input')].map(input=>[input.dataset.row,input.value.trim()]))).filter(r=>Object.values(r).some(Boolean));
  current.edited=true;current.status=confirmResult?'confirmed':'review';dirty=false;render();
}
async function showPage(){
  rect=current.regions?.[page+':'+$('regionField').value]||null;$('regionBox').hidden=true;$('canvasStage').hidden=!current.file;$('missingPdf').hidden=!!current.file;
  if(current.file){await renderPage(current,page,$('canvas'));$('pageInfo').textContent=`${page} / ${current.pages}`;}else $('pageInfo').textContent='원본 없음';
  paintRect();
}
async function openReview(doc){if(busy)return;current=doc;page=1;dirty=false;$('reviewName').textContent=doc.name;form();$('review').showModal();await run(showPage);}
function closeReview(){if(busy)return;if(dirty&&!confirm('저장하지 않은 수정값을 닫을까요?'))return;$('review').close();document.body.append($('toast'));current=null;rect=null;dirty=false;render();}
$('closeReview').onclick=closeReview;$('review').oncancel=e=>{e.preventDefault();closeReview();};
$('prev').onclick=()=>{if(page>1)run(async()=>{page--;await showPage();});};$('next').onclick=()=>{if(page<(current.pages||1))run(async()=>{page++;await showPage();});};
$('regionField').onchange=()=>{rect=current.regions?.[page+':'+$('regionField').value]||null;paintRect();render();};
function paintRect(){const el=$('regionBox');el.hidden=!rect;if(rect){Object.assign(el.style,{left:rect.x*100+'%',top:rect.y*100+'%',width:rect.w*100+'%',height:rect.h*100+'%'});}$('regionHint').textContent=rect?'선택 영역 준비됨':'PDF 위에 읽을 영역을 그리세요.';}
const clamp=x=>Math.max(0,Math.min(1,x));
function position(e){const b=$('canvasStage').getBoundingClientRect();return {x:clamp((e.clientX-b.left)/b.width),y:clamp((e.clientY-b.top)/b.height)};}
$('canvasStage').onpointerdown=e=>{if(busy||!current?.file)return;e.preventDefault();drag=position(e);$('canvasStage').setPointerCapture(e.pointerId);};
$('canvasStage').onpointermove=e=>{if(!drag)return;const p=position(e);rect={x:Math.min(p.x,drag.x),y:Math.min(p.y,drag.y),w:Math.abs(p.x-drag.x),h:Math.abs(p.y-drag.y)};paintRect();};
$('canvasStage').onpointerup=()=>{if(!drag)return;drag=null;if(!rect||rect.w<.005||rect.h<.003)rect=null;else{current.regions[page+':'+$('regionField').value]={...rect};}paintRect();render();};
$('canvasStage').onpointercancel=()=>{drag=null;};
$('readRegion').onclick=()=>run(async()=>{
  const lines=await readPage(current,page,rect),key=$('regionField').value,raw=lines.map(l=>l.text).join('\n');
  if(!raw.trim()){toast('영역에서 글자를 찾지 못했습니다. 범위를 넓혀 주세요.');return;}
  if(key==='measurements'){
    const rows=extractMeasurements(lines,{region:true});if(!rows.length){toast('측정 열을 구분하지 못했습니다. 원문을 확인하고 행을 추가하세요.');}else{
      if($('measurements').children.length&&!confirm('기존 측정행을 선택 영역에서 읽은 값으로 바꿀까요?'))return;
      $('measurements').innerHTML='';rows.forEach(addRow);dirty=true;
    }
  }else{const input=$('fields').querySelector(`[name=${key}]`);input.value=cleanField(key,raw);dirty=true;updateBadge();}
  $('raw').textContent=raw;current.lines.push(...lines);toast('선택한 영역을 읽었습니다.');
});
$('reviewForm').oninput=()=>{dirty=true;updateBadge();};$('addRow').onclick=()=>{addRow();dirty=true;};
$('saveDraft').onclick=()=>{if(busy)return;saveForm();toast('수정값을 현재 작업에 저장했습니다.');};
$('reviewForm').onsubmit=e=>{e.preventDefault();if(busy)return;saveForm(true);closeReview();toast('결과를 확정했습니다.');};
async function xlsx(){
  if(window.XLSX)return window.XLSX;
  if(!xlsxPromise)xlsxPromise=new Promise((resolve,reject)=>{const el=document.createElement('script');el.src='https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js';el.onload=()=>resolve(window.XLSX);el.onerror=()=>{xlsxPromise=null;el.remove();reject(Error('Excel 모듈을 읽지 못했습니다. 인터넷 연결을 확인하세요.'));};document.head.append(el);});return xlsxPromise;
}
$('export').onclick=()=>run(async()=>{
  const chosen=selected().filter(d=>d.status==='confirmed');if(!chosen.length)throw Error('확정한 문서를 선택하세요.');
  const XLSX=await xlsx(),rows=[['문서명',...FIELDS.map(f=>f[1]),'측정점','측정값','측정 단위','측정 구분','관리번호 확인']];
  for(const d of chosen)for(const r of d.rows.length?d.rows:[{}])rows.push([d.name,...FIELDS.map(([key])=>d.fields[key]||''),r.point||'',r.value||'',r.unit||'',r.type||'',idMatch(d.name,d.fields.instrument_number)]);
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);
  // All identifiers and measurements remain strings, including leading/trailing zeros.
  for(const key of Object.keys(sheet))if(!key.startsWith('!')){sheet[key].t='s';sheet[key].v=String(sheet[key].v??'');delete sheet[key].f;}
  sheet['!cols']=rows[0].map((_,i)=>({wch:i===0?34:20}));sheet['!autofilter']={ref:sheet['!ref']};XLSX.utils.book_append_sheet(book,sheet,'교정결과');
  download(new Blob([XLSX.write(book,{bookType:'xlsx',type:'array',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'Certi-OCR-'+new Date().toISOString().slice(0,10)+'.xlsx');toast(`${chosen.length}개 확정 문서를 저장했습니다.`);
});
$('save').onclick=()=>{const records=docs.map(({id,name,pages,fields,rows,status,regions,engine})=>({id,name,pages,fields,rows,status,regions,engine}));download(new Blob([JSON.stringify({format:'certi-web-lite',version:1,documents:records},null,2)],{type:'application/json'}),'Certi-OCR-작업.json');toast('작업을 저장했습니다. 원본 PDF는 포함되지 않습니다.');};
$('restore').onclick=()=>$('project').click();
$('project').onchange=e=>run(async()=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;if(file.size>5*1024**2)throw Error('작업 파일은 5MB 이하만 열 수 있습니다.');
  const project=JSON.parse(await file.text());if(project.format!=='certi-web-lite'||project.version!==1||!Array.isArray(project.documents)||project.documents.length>20)throw Error('지원하는 작업 파일이 아닙니다.');
  const incoming=project.documents.map(d=>{
    if(!/^[a-f0-9]{64}$/.test(d.id)||typeof d.name!=='string'||d.name.length>300||!Array.isArray(d.rows)||d.rows.length>5000)throw Error('작업 자료 형식을 확인하세요.');
    const text=v=>{if(v!=null&&typeof v!=='string')throw Error('문자열 값이 아닌 항목이 있습니다.');if((v||'').length>2000)throw Error('항목 값이 너무 깁니다.');return v||'';};
    const regions={};for(const [key,r] of Object.entries(d.regions||{}))if(/^\d+:[a-z_]+$/.test(key)&&['x','y','w','h'].every(k=>Number.isFinite(r[k])&&r[k]>=0&&r[k]<=1)&&r.x+r.w<=1.001&&r.y+r.h<=1.001)regions[key]={x:r.x,y:r.y,w:r.w,h:r.h};
    return {id:d.id,name:d.name,pages:Number.isInteger(d.pages)?d.pages:undefined,fields:Object.fromEntries(FIELDS.map(([key])=>[key,text(d.fields?.[key])])),rows:d.rows.map(r=>Object.fromEntries(['point','value','unit','type'].map(k=>[k,text(r[k])]))),status:labels[d.status]?d.status:'review',regions,engine:text(d.engine),lines:[],checked:true,edited:true,file:docs.find(old=>old.id===d.id)?.file};
  });
  if(docs.length&&!confirm('현재 작업을 저장한 작업으로 바꿀까요? 저장하지 않은 값은 사라집니다.'))return;
  if(current)await releaseDocument(current.id);docs.splice(0,docs.length,...incoming);toast('작업을 열었습니다. 필요한 원본 PDF를 추가하세요.');
});
window.addEventListener('beforeunload',e=>{if(docs.length){e.preventDefault();e.returnValue='';}});
render();
