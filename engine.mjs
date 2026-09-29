const PDF_BASE='https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/';
let pdfModule,ocrWorker,ocrInit,activePdf,activeTask,activeId,idleTimer;
let log=()=>{};
export const setProgress=fn=>{log=fn;};
export async function pdfFor(doc){
  if(!doc.file)throw Error('원본 PDF를 다시 추가하세요.');
  if(activeId===doc.id&&activePdf)return activePdf;
  if(activeTask){await activeTask.destroy();activeTask=null;activePdf=null;activeId=null;}
  try{pdfModule??=await import(PDF_BASE+'build/pdf.mjs');}
  catch{throw Error('PDF 엔진을 불러오지 못했습니다. 인터넷 연결 또는 CDN 접속 정책을 확인하세요.');}
  pdfModule.GlobalWorkerOptions.workerSrc=PDF_BASE+'build/pdf.worker.mjs';
  try{
    activeTask=pdfModule.getDocument({data:new Uint8Array(await doc.file.arrayBuffer()),
      isEvalSupported:false,enableXfa:false,cMapUrl:PDF_BASE+'cmaps/',cMapPacked:true,
      standardFontDataUrl:PDF_BASE+'standard_fonts/',wasmUrl:PDF_BASE+'wasm/'});
    activePdf=await activeTask.promise;
  }catch(e){if(e.name==='PasswordException')throw Error('이 PDF는 열기 비밀번호가 필요합니다. 비밀번호 없이 열리는 사본을 선택하세요.');throw Error('PDF를 열지 못했습니다. 파일 손상 여부를 확인하세요.');}
  if(activePdf.numPages>100){await activeTask.destroy();activeTask=null;activePdf=null;throw Error('문서당 최대 100페이지입니다. 필요한 페이지를 나눠 주세요.');}
  activeId=doc.id;doc.pages=activePdf.numPages;return activePdf;
}
export function groupWords(words,page,engine){
  const rows=[];
  for(const w of words.filter(w=>w.text.trim()).sort((a,b)=>a.y-b.y||a.x-b.x)){
    let row=rows.find(r=>Math.abs(r.y-w.y)<Math.max(.003,Math.min(w.h,r.h)*.45));
    if(!row){row={y:w.y,h:w.h,words:[]};rows.push(row);}row.words.push(w);
  }
  return rows.sort((a,b)=>a.y-b.y).map(r=>({...r,page,engine,words:r.words.sort((a,b)=>a.x-b.x),text:r.words.map(w=>w.text).join(' ')}));
}
export async function nativePage(doc,n){
  doc.native??=new Map();if(doc.native.has(n))return doc.native.get(n);
  const page=await(await pdfFor(doc)).getPage(n),viewport=page.getViewport({scale:1});
  const content=await page.getTextContent();
  const words=content.items.filter(x=>typeof x.str==='string'&&x.str.trim()).map(item=>{
    const t=pdfModule.Util.transform(viewport.transform,item.transform),h=Math.hypot(t[2],t[3]);
    return {text:item.str,x:t[4]/viewport.width,y:(t[5]-h)/viewport.height,w:item.width/viewport.width,h:h/viewport.height};
  });
  const lines=groupWords(words,n,'PDF 텍스트');doc.native.set(n,lines);page.cleanup();return lines;
}
export async function renderPage(doc,n,canvas,{scale=1.4,rect=null}={}){
  const page=await(await pdfFor(doc)).getPage(n),viewport=page.getViewport({scale});
  const r=rect||{x:0,y:0,w:1,h:1};
  const reduction=Math.min(1,Math.sqrt(14000000/(viewport.width*r.w*viewport.height*r.h)));
  const v=page.getViewport({scale:scale*reduction});
  canvas.width=Math.max(1,Math.ceil(v.width*r.w));canvas.height=Math.max(1,Math.ceil(v.height*r.h));
  await page.render({canvasContext:canvas.getContext('2d'),viewport:v,background:'rgb(255,255,255)',transform:rect?[1,0,0,1,-v.width*r.x,-v.height*r.y]:undefined}).promise;
  page.cleanup();return canvas;
}
async function worker(){
  clearTimeout(idleTimer);
  if(ocrWorker)return ocrWorker;
  if(!ocrInit)ocrInit=(async()=>{
    try{
      const {default:{createWorker}}=await import('https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js');
      const w=await createWorker(['kor','eng'],1,{
        workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
        corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
        logger:m=>log(m.status==='recognizing text'?'글자 인식 중':'OCR 엔진 준비 중',m.progress||0)
      });
      await w.setParameters({preserve_interword_spaces:'1',user_defined_dpi:'216'});ocrWorker=w;return w;
    }catch{throw Error('OCR 엔진을 준비하지 못했습니다. 인터넷 연결과 CDN 접속 정책을 확인하세요.');}
    finally{ocrInit=null;}
  })();
  return ocrInit;
}
function usable(lines){const text=lines.map(l=>l.text).join('');return text.length>=24&&(text.match(/[A-Za-z0-9가-힣]/g)||[]).length/text.length>.5;}
export async function readPage(doc,n,rect=null){
  const key=String(n)+(rect?':'+[rect.x,rect.y,rect.w,rect.h].map(v=>v.toFixed(4)).join(','):'');
  doc.cache??=new Map();if(doc.cache.has(key))return doc.cache.get(key);
  const native=await nativePage(doc,n);
  const selected=rect?groupWords(native.flatMap(l=>l.words).filter(w=>w.x+w.w/2>=rect.x&&w.x+w.w/2<=rect.x+rect.w&&w.y+w.h/2>=rect.y&&w.y+w.h/2<=rect.y+rect.h),n,'PDF 텍스트'):native;
  if(usable(native)&&selected.length){doc.cache.set(key,selected);return selected;}
  const canvas=document.createElement('canvas');
  try{
    await renderPage(doc,n,canvas,{scale:3,rect});
    const w=await worker();
    // Automatic rotation helps slightly skewed scans; output stays in the chosen region.
    const {data}=await w.recognize(canvas,{rotateAuto:true},{text:true,blocks:true});
    const area=rect||{x:0,y:0,w:1,h:1};
    const words=(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>(p.lines||[]).flatMap(l=>(l.words||[]).map(word=>({
      text:word.text,confidence:word.confidence,x:area.x+word.bbox.x0/canvas.width*area.w,
      y:area.y+word.bbox.y0/canvas.height*area.h,w:(word.bbox.x1-word.bbox.x0)/canvas.width*area.w,h:(word.bbox.y1-word.bbox.y0)/canvas.height*area.h
    })))));
    const lines=words.length?groupWords(words,n,'스캔 OCR'):data.text.split('\n').filter(t=>t.trim()).map((text,i)=>({text,page:n,y:area.y+i*.02,words:[],engine:'스캔 OCR'}));
    doc.cache.set(key,lines);while(doc.cache.size>120)doc.cache.delete(doc.cache.keys().next().value);
    return lines;
  }finally{
    canvas.width=canvas.height=1;
    idleTimer=setTimeout(async()=>{const old=ocrWorker;ocrWorker=null;if(old)await old.terminate();},60000);
  }
}
export async function releaseDocument(id){if(id===activeId&&activeTask){await activeTask.destroy();activeTask=null;activePdf=null;activeId=null;}}
