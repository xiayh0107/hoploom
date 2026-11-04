import {beforeEach,describe,expect,it,vi} from 'vitest';
import {api,ApiError,download,json,setCsrf,stream,upload} from './api';
const fetchMock=vi.fn<typeof fetch>();
beforeEach(()=>{document.querySelector('meta[name="hoploom-frame"]')?.remove();fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock);setCsrf('test-csrf');});
describe('same-origin API client',()=>{
  it('protects mutations, preserves multipart boundaries and requests no-store cookies',async()=>{
    fetchMock.mockResolvedValue(new Response('{}'));const body=new FormData();body.append('file',new File(['data'],'payload.txt'));
    await api('/hosts/a/upload',{method:'POST',body});
    const [url,options]=fetchMock.mock.calls[0];expect(url).toBe('/api/v1/hosts/a/upload');expect(options?.credentials).toBe('same-origin');expect(options?.cache).toBe('no-store');
    const headers=new Headers(options?.headers);expect(headers.get('X-CSRF-Token')).toBe('test-csrf');expect(headers.has('Content-Type')).toBe(false);
  });
  it('tunnels embedded requests without losing method, CSRF or multipart boundaries',async()=>{
    const meta=document.createElement('meta');meta.name='hoploom-frame';meta.content='synthetic-frame';document.head.append(meta);
    fetchMock.mockImplementation(async()=>new Response('{}'));
    await api('/runtime');
    const [url,options]=fetchMock.mock.calls[0];expect(url).toBe('./ui-api?path=%2Fruntime');expect(options?.method).toBe('POST');
    const headers=new Headers(options?.headers);expect(headers.get('X-Hoploom-Method')).toBe('GET');expect(headers.get('X-Hoploom-Frame')).toBe('synthetic-frame');expect(headers.has('X-CSRF-Token')).toBe(false);
    const body=new FormData();body.append('file',new File(['data'],'payload.txt'));
    await api('/hosts/a/upload',{method:'POST',body});const upload=new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(upload.get('X-CSRF-Token')).toBe('test-csrf');expect(upload.has('Content-Type')).toBe(false);expect(fetchMock.mock.calls[1][1]?.body).toBe(body);
  });
  it('normalizes business and HTTP errors without retrying writes',async()=>{
    fetchMock.mockResolvedValue(new Response(JSON.stringify({detail:'Permission denied'}),{status:403}));
    await expect(api('/hosts',json('POST',{}))).rejects.toMatchObject({status:403,message:'Permission denied'});expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('signals session expiry once without replaying a request',async()=>{
    const expired=vi.fn();window.addEventListener('ssm-session-expired',expired);fetchMock.mockResolvedValue(new Response('{}',{status:401}));
    await expect(api('/hosts',json('POST',{}))).rejects.toBeInstanceOf(ApiError);expect(expired).toHaveBeenCalledTimes(1);expect(fetchMock).toHaveBeenCalledTimes(1);window.removeEventListener('ssm-session-expired',expired);
  });
  it('downloads binary content using POST and RFC5987 filenames',async()=>{
    fetchMock.mockResolvedValue(new Response('payload',{headers:{'Content-Disposition':"attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%23.txt"}}));
    const result=await download('/hosts/a/download',{path:'/中文 #.txt'});expect(result.filename).toBe('中文 #.txt');expect(await result.blob.text()).toBe('payload');expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });
  it('streams a download with byte progress and refuses one that ends early',async()=>{
    const body=()=>new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('abc'));controller.enqueue(new TextEncoder().encode('de'));controller.close();}});
    fetchMock.mockResolvedValue(new Response(body(),{headers:{'Content-Length':'5','Content-Disposition':"attachment; filename*=UTF-8''log.txt"}}));
    const progress=vi.fn(),signal=new AbortController().signal;
    const result=await download('/hosts/a/download',{path:'/log.txt'},{signal,onProgress:progress});
    expect(await result.blob.text()).toBe('abcde');expect(progress.mock.calls).toEqual([[0,5],[3,5],[5,5]]);expect(fetchMock.mock.calls[0][1]?.signal).toBe(signal);
    fetchMock.mockResolvedValue(new Response(body(),{headers:{'Content-Length':'9'}}));
    await expect(download('/hosts/a/download',{path:'/log.txt'},{onProgress:vi.fn()})).rejects.toThrow('ended early');
    // The embedded proxy sends no length; progress still counts bytes.
    fetchMock.mockResolvedValue(new Response(body()));const unsized=vi.fn();
    await download('/hosts/a/download',{path:'/log.txt'},{onProgress:unsized});expect(unsized).toHaveBeenLastCalledWith(5,undefined);
  });
  it('uploads through XHR with the shared CSRF, embedded and error rules',async()=>{
    class FakeXHR{
      static last:FakeXHR;method='';url='';headers:Record<string,string>={};body:unknown;status=0;response:unknown=null;responseType='';aborted=false;
      upload:{onprogress?:(event:ProgressEvent)=>void;onload?:()=>void}={};onload?:()=>void;onerror?:()=>void;onabort?:()=>void;
      constructor(){FakeXHR.last=this;}
      open(method:string,url:string){this.method=method;this.url=url;}
      setRequestHeader(name:string,value:string){this.headers[name.toLowerCase()]=value;}
      send(body:unknown){this.body=body;}
      abort(){this.aborted=true;this.onabort?.();}
      getAllResponseHeaders(){return 'content-type: application/json\r\n';}
      answer(status:number,body:unknown){this.status=status;this.response=JSON.stringify(body);this.onload?.();}
    }
    vi.stubGlobal('XMLHttpRequest',FakeXHR);
    const form=new FormData();form.append('file',new File(['data'],'payload.txt'));
    const progress=vi.fn(),sent=vi.fn();
    let pending=upload('/hosts/a/upload',form,{onProgress:progress,onSent:sent});
    let xhr=FakeXHR.last;expect([xhr.method,xhr.url]).toEqual(['POST','/api/v1/hosts/a/upload']);
    expect(xhr.headers['x-csrf-token']).toBe('test-csrf');expect(xhr.headers['content-type']).toBeUndefined();expect(xhr.body).toBe(form);
    xhr.upload.onprogress?.({loaded:2,total:4,lengthComputable:true} as ProgressEvent);xhr.upload.onload?.();
    expect(progress).toHaveBeenCalledWith(2,4);expect(sent).toHaveBeenCalledOnce();
    xhr.answer(200,{bytes:4});await expect(pending).resolves.toEqual({bytes:4});
    pending=upload('/hosts/a/upload',form);FakeXHR.last.answer(409,{ok:false,error:'FileOperationError',error_code:'exists',message:'Already exists',existing:{type:'file'}});
    await expect(pending).rejects.toMatchObject({status:409,code:'exists',existing:{type:'file'}});
    const controller=new AbortController();pending=upload('/hosts/a/upload',form,{signal:controller.signal});controller.abort();
    expect(FakeXHR.last.aborted).toBe(true);await expect(pending).rejects.toMatchObject({name:'AbortError'});
    const meta=document.createElement('meta');meta.name='hoploom-frame';meta.content='synthetic-frame';document.head.append(meta);
    pending=upload('/hosts/a/upload',form);xhr=FakeXHR.last;
    expect([xhr.method,xhr.url]).toEqual(['POST','./ui-api?path=%2Fhosts%2Fa%2Fupload']);
    expect(xhr.headers['x-hoploom-method']).toBe('POST');expect(xhr.headers['x-hoploom-frame']).toBe('synthetic-frame');expect(xhr.headers['x-csrf-token']).toBe('test-csrf');
    xhr.answer(200,{});await pending;
    vi.unstubAllGlobals();
  });
  it('requires a final diagnostic result and cleans the stream',async()=>{
    fetchMock.mockResolvedValue(new Response('{"type":"stage","message":"Waiting"}\n'));await expect(stream('/credentials/a/test',{},vi.fn(),new AbortController().signal)).rejects.toThrow('before the test completed');
    fetchMock.mockResolvedValue(new Response('{"type":"stage","message":"Ready"}\n{"type":"result","result":{"ok":true}}\n'));const receive=vi.fn();await stream('/credentials/a/test',{},receive,new AbortController().signal);expect(receive).toHaveBeenCalledTimes(2);
  });
});
