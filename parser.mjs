export const FIELDS = [
  ['certificate_number','성적서 번호',['성적서 번호','성적서번호','Certificate No','Certificate Number','Test No']],
  ['calibration_date','교정일자',['교정일자','교정일','시험일자','Date of Calibration','Calibration Date','Date of Test']],
  ['instrument_number','관리번호',['계측기번호','관리번호','설비번호','기기번호','Equipment No','Asset No','Tag No']],
  ['instrument_name','계측기명',['계측기명','기기명','기기','품명','Instrument Name','Description']],
  ['manufacturer','제조사',['제작회사','제조사','제작사','Manufacturer']],
  ['model_name','모델명',['모델명','형식','Model Name','Model']],
  ['unit','단위',['단위','Unit']],
  ['serial_number','시리얼 번호',['시리얼 번호','일련번호','Serial Number','Serial Nurnber','Serial No','S/N']]
];
const escapeRE=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function labelRE(alias){
  const part=/[가-힣]/.test(alias)?[...alias.replace(/\s/g,'')].map(escapeRE).join('\\s*'):alias.split(/\s+/).map(escapeRE).join('\\s*');
  return new RegExp('(?:^|[\\s.(·:：])('+part+')(?![A-Za-z가-힣])','i');
}
const rules=FIELDS.map(([key,label,aliases])=>({key,label,patterns:aliases.map(labelRE)}));
function hits(text){return rules.flatMap(r=>r.patterns.map(pattern=>{const m=pattern.exec(text);return m?{key:r.key,start:m.index,end:m.index+m[0].length}:null}).filter(Boolean)).sort((a,b)=>a.start-b.start||b.end-a.end);}
export function normalizeId(value){
  const v=String(value).toUpperCase().replace(/[‐‑–—]/g,'-').replace(/\s+/g,'');
  const m=v.match(/^([A-Z0-9]{5})-([A-Z01]{2}[0-9OIL]{2})-([A-Z01]{2}[0-9OIL]{2})$/);
  if(!m)return v;
  const part=s=>s.slice(0,2).replace(/0/g,'O').replace(/1/g,'I')+s.slice(2).replace(/O/g,'0').replace(/[IL]/g,'1');
  return `${m[1]}-${part(m[2])}-${part(m[3])}`;
}
export function filenameId(name){return name.replace(/\.pdf$/i,'').match(/^([A-Z0-9]{5}-[A-Z]{2}\d{2}-[A-Z]{2}\d{2})(?=$|[_\s])/i)?.[1]?.toUpperCase()||'';}
export function idMatch(name,value){const expected=filenameId(name);return !expected?'비교 없음':!value?'확인필요':normalizeId(value)===expected?'OK':'확인필요';}
export function normalizeUnit(raw){
  let s=String(raw).trim().replace(/[µμu]S\s*[\/lI]\s*cm/gi,'μS/cm').replace(/4S\s*[\/lI]\s*cm/g,'μS/cm').replace(/mS\s*[\/lI]\s*cm/g,'mS/cm').replace(/℃|°\s*C/g,'°C').replace(/%\s*R\.?\s*H\.?/gi,'% R.H.');
  const matches=s.match(/μS\/cm|mS\/cm|% R\.H\.|°C|mmHg|MPa|kPa|mbar|bar|mA|mV|(?<![A-Za-z])(?:mm|cm|kg|g|N|V|pH|%)(?![A-Za-z])/g);
  return matches?[...new Set(matches)].join(' / '):s;
}
export function cleanField(key,raw){
  let s=String(raw||'').replace(/\r/g,'').trim();
  const match=hits(s).find(h=>h.key===key);
  if(match){
    const next=hits(s).find(h=>h.start>=match.end && h.key!==key);
    s=s.slice(match.end,next?.start).trim();
    // Remove translated labels printed in parentheses after the Korean label.
    s=s.replace(/^[\s.(]*(?:Date of Calibration|Calibration Date|Serial N(?:umber|urnber)|Serial No\.?|Instrument Name|Description|Certificate N(?:o\.?|umber)|Unit|Equipment No\.?)[\s.)]*/i,'');
  }
  s=s.replace(/^[\s.():：'"’•]+|[\s)]+$/g,'').split('\n').map(x=>x.trim()).filter(Boolean).join(' ');
  if(key==='calibration_date'){
    if(/차기|다음|유효|next|due|expiry|expiration/i.test(s))return '';
    const m=s.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
    if(m){const [y,mo,d]=m.slice(1).map(Number),date=new Date(Date.UTC(y,mo-1,d));if(date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)return '';return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
  }
  if(key==='instrument_number')return normalizeId(s);
  if(key==='instrument_name')s=s.replace(/\bSengor\b/gi,'Sensor').replace(/\bCel1\b/gi,'Cell').replace(/\s+\d+[,.][.,\d\s]*$/,'');
  return key==='unit'?normalizeUnit(s):s;
}
export function extractFields(lines){
  const fields=Object.fromEntries(FIELDS.map(([key])=>[key,''])),sources={};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    for(const h of hits(line.text)){
      if(fields[h.key])continue;
      if(h.key==='calibration_date'&&/차기|다음|유효|next|due|expiry/i.test(line.text))continue;
      let value=cleanField(h.key,line.text);
      if(!value){const next=lines[i+1];if(next&&next.page===line.page&&next.y-line.y<.06&&!hits(next.text).length)value=cleanField(h.key,next.text);}
      if(!value||/교정\s*환경|Environment/i.test(value))continue;
      if(h.key==='calibration_date'&&!/^20\d{2}-\d{2}-\d{2}$/.test(value))continue;
      fields[h.key]=value;sources[h.key]={page:line.page,text:line.text,engine:line.engine};
    }
  }
  return {fields,sources};
}
export function numericTokens(text){return String(text).replace(/(\d\.\d{3}(?:\d{3})*)[ \t]+(\d)(?=[ \t]+[-+−]?\d)/g,'$1$2').match(/[-+−]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?/g)?.map(s=>s.replace(/−/g,'-'))||[];}
export function extractMeasurements(lines,{region=false}={}){
  let header=null,unit='',lastPoint='',lastPage=0;const rows=[];
  for(const line of lines){
    if(line.page!==lastPage){header=null;unit='';lastPoint='';lastPage=line.page;}
    if(/Unit|단위|Humidity|Temperature/i.test(line.text)){const u=normalizeUnit(line.text);if(u!==line.text||/^(?:°C|% R\.H\.|μS\/cm|mm|kg)$/.test(u))unit=u;}
    const words=line.words||[];
    const point=words.find(w=>/기준값|명목값|측정점|설정값|표준값|cal\.?\s*point|nominal|reference/i.test(w.text));
    const readings=words.filter(w=>/측정값|측정결과|지시값|상[동용]질량|reading|measured|보정\s*[전후]|adjustment/i.test(w.text));
    if(point&&readings.length){header={point:point.x+point.w/2,readings:readings.map(w=>({x:w.x+w.w/2,type:/보정\s*후|after/i.test(w.text)?'보정 후':/보정\s*전|before/i.test(w.text)?'보정 전':''}))};lastPoint='';continue;}
    if(/측정점|명목값|기준값|cal\.?\s*point|nominal/i.test(line.text)&&/측정|지시|질량|reading|measured|보정/i.test(line.text)){header={simple:true};continue;}
    if(!header&&!region)continue;
    if(/불확도|uncertainty|성적서|교정일|환경|tolerance/i.test(line.text)){header=null;lastPoint='';continue;}
    if(header&&!header.simple){
      const columns=[{x:header.point,key:'point'},...header.readings.map((r,i)=>({...r,key:String(i)}))],cells={};
      for(const word of words){if(!/^\s*[-+−]?\d[\d.,\s]*(?:[eE][-+]?\d+)?\s*$/.test(word.text))continue;const x=word.x+word.w/2;const nearest=columns.reduce((a,b)=>Math.abs(a.x-x)<Math.abs(b.x-x)?a:b);if(Math.abs(nearest.x-x)>.12)continue;(cells[nearest.key]??=[]).push(word.text);}
      const value=key=>numericTokens((cells[key]||[]).join(' ').replace(/^(\s*[-+−]?\d+\.\d{3}(?:\d{3})*)\s+(\d)\s*$/,'$1$2')).join(' ');
      const p=value('point');if(p)lastPoint=p;
      let usable=header.readings.map((r,i)=>({type:r.type,value:value(String(i))})).filter(r=>r.value);
      if(usable.some(r=>r.type==='보정 후'))usable=usable.filter(r=>r.type==='보정 후');
      if(lastPoint)for(const r of usable)rows.push({point:lastPoint,value:r.value,unit,type:r.type,page:line.page});
    }else{
      const numbers=numericTokens(line.text);if(numbers.length===2&&!/[가-힣A-DF-Za-df-z]/.test(line.text))rows.push({point:numbers[0],value:numbers[1],unit,type:'',page:line.page});
    }
  }
  return rows;
}
export function pageNumbers(value,total){
  if(!value.trim())return Array.from({length:total},(_,i)=>i+1);
  const selected=new Set();
  for(const part of value.split(',')){const m=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);if(!m)throw Error('페이지는 1, 3-5처럼 입력하세요.');const a=+m[1],b=+(m[2]||m[1]);if(a<1||b<a||b>total)throw Error(`페이지 범위는 1~${total}입니다.`);for(let n=a;n<=b;n++)selected.add(n);}
  return [...selected].sort((a,b)=>a-b);
}
