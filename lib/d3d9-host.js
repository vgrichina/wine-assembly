// Synchronous GPU bridge. WAT owns the descriptor/state/resource allocations.
// No guest pointers are retained for deferred execution: draw snapshots are
// consumed before the importing instruction resumes, in both host modes.
(function (root, factory) {
  const node = typeof module !== 'undefined' && module.exports;
  const api = factory(node ? require('./d3d9-backend') : root.D3D9Backend);
  if (node) module.exports = api; else root.D3D9Host = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Backend) {
  'use strict';
  class Bridge {
    constructor(options) { this.options = options; this.devices = new Map(); this.lastError = null; }
    call(opcode, address, aux) {
      if(opcode===0x30005) {
        if(!this.options.enableProgrammable || typeof document==='undefined')return 0;
        if(this.probed===undefined)this.probed=Backend.probe(document.createElement('canvas'));
        return this.probed?1:0;
      }
      const memory = this.options.getMemory(), view = new DataView(memory);
      const u32 = offset => view.getUint32(offset, true);
      const g2w = pointer => this.options.guestToWasm(pointer);
      if (opcode === 0x30004) {
        const entry = this.devices.get(aux >>> 0);
        if (entry) {
          entry.device.destroy();
          if (entry.win._gpuFrameLayer === entry.layer) entry.win._gpuFrameLayer = null;
          if (entry.win._dxFrameLayer === entry.layer) entry.win._dxFrameLayer = null;
          this.devices.delete(aux >>> 0);
        }
        return 1;
      }
      try {
        const id = u32(address), program = g2w(u32(address+4)),
          width = u32(address+12), height = u32(address+16), hwnd = u32(address+20);
        let entry = this.devices.get(id);
        if (!entry && opcode !== 0x30001) return 0;
        if (!entry) {
          const renderer = this.options.renderer();
          const win = renderer && renderer.windows[hwnd];
          if (!win || typeof document === 'undefined') throw new Error('D3D9 requires a GPU window');
          if (!width || !height || width > 4096 || height > 4096) throw new Error('invalid GPU target size');
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          if (view.getFloat32(program+1696,true) !== 1) throw new Error('D3D9 non-default depth clear is not implemented');
          const device = new Backend.Device(canvas);
          const layer = { canvas: device.gpu.getPresentationSurface(), backend: device.gpu, writeSeq: 0, kind: 'gpu' };
          entry = { device, layer, win }; this.devices.set(id, entry);
          const color = u32(program+1688);
          device.clear([((color>>>16)&255)/255,((color>>>8)&255)/255,(color&255)/255,(color>>>24)/255], 3);
        }
        const { device, win, layer } = entry;
        if (opcode === 0x30002) {
          // Publish and synchronize canonical guest-visible back-buffer bytes
          // at the explicit present boundary; never expose a half-built frame.
          const gpu = device.gpu, gl = gpu.gl;
          const rgba = gpu.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(width*height*4));
          const dest = new Uint8Array(memory, u32(address+8), width*height*4);
          for (let y=0;y<height;++y) for(let x=0;x<width;++x) {
            const from=((height-1-y)*width+x)*4, to=(y*width+x)*4;
            dest[to]=rgba[from+2]; dest[to+1]=rgba[from+1]; dest[to+2]=rgba[from]; dest[to+3]=rgba[from+3];
          }
          layer.canvas = device.present(); layer.writeSeq++;
          win._gpuFrameLayer = layer; win._dxFrameLayer = layer;
          if (this.options.onPresent) this.options.onPresent(layer);
          const renderer = this.options.renderer(); renderer.needsRepaint = true;
          return 1;
        }
        if (opcode === 0x30003) {
          if (u32(address+56)) throw new Error('D3D9 rectangular clear is not implemented');
          const color = u32(address+48), z = view.getFloat32(address+52,true);
          if (z !== 1) throw new Error('D3D9 non-default depth clear is not implemented');
          device.clear([((color>>>16)&255)/255,((color>>>8)&255)/255,(color&255)/255,(color>>>24)/255],u32(address+44));
          return 1;
        }
        const declaration=u32(program+8), fvf = u32(program+12);
        const position=fvf&0x400e,texCount=(fvf>>>8)&15;
        if (!declaration && (![2,0x4002].includes(position) || texCount>4 || (fvf&0xb021)))
          throw new Error(`D3D9 FVF ${fvf.toString(16)} is not implemented`);
        const primitive = u32(address+24), primitiveCount = u32(address+28), stride = u32(address+36);
        const count = Backend.primitiveVertices(primitive, primitiveCount), byteCount = count*stride;
        if (!stride || stride>255 || !Number.isSafeInteger(byteCount) || byteCount>0x10000000)
          throw new Error('invalid D3D9 draw byte range');
        const shader = offset => {
          const ptr = g2w(u32(program+offset)), length = u32(ptr+16);
          if (!length || length%4 || length>262144) throw new Error('invalid shader resource');
          return new Uint32Array(memory,ptr+24,length/4).slice();
        };
        const state = g2w(u32(address+40));
        const rs = id => u32(state+256+id*4);
        let vertices, indices, vertexCount=count;
        const indexPointer=u32(address+44), vertexPointer=u32(address+32);
        if(indexPointer) {
          const format=u32(address+48), min=u32(address+52), num=u32(address+56), end=min+num;
          if(![101,102].includes(format) || !num || end>0x100000000)
            throw new Error('invalid indexed vertex range');
          const indexBytes=format===101?2:4, start=g2w(indexPointer);
          if(start===0xf0 || start+count*indexBytes>memory.byteLength)
            throw new Error('invalid index memory range');
          const values=new Uint32Array(count);
          for(let i=0;i<count;++i) {
            const value=indexBytes===2?view.getUint16(start+i*2,true):u32(start+i*4);
            if(value<min || value>=end)throw new Error('index outside declared vertex range');
            values[i]=value;
          }
          // INDEX32 needs no WebGL extension: expand the referenced vertices
          // without truncating indices. INDEX16 retains the indexed GPU path.
          if(format===102) {
            vertices=new Uint8Array(byteCount);
            for(let i=0;i<count;++i) {
              const p=vertexPointer+values[i]*stride;
              if(p+stride>0x100000000 || g2w(p)===0xf0)throw new Error('vertex address overflow/unmapped');
              vertices.set(new Uint8Array(memory,g2w(p),stride),i*stride);
            }
          } else {
            vertexCount=num;
            const p=vertexPointer+min*stride, length=num*stride;
            if(length>0x10000000 || p+length>0x100000000 || g2w(p)===0xf0)
              throw new Error('invalid indexed vertex bytes');
            vertices=new Uint8Array(memory,g2w(p),length).slice();
            indices=Uint16Array.from(values,value=>value-min);
          }
        } else vertices=new Uint8Array(memory,g2w(vertexPointer),byteCount).slice();
        const attributes=[],convertedColors=new Set();
        const convertColor=offset=>{
          if(offset+4>stride)throw new Error('color outside vertex stride');
          if(convertedColors.has(offset))return;
          convertedColors.add(offset);
          for(let i=0;i<vertexCount;++i){const p=i*stride+offset;[vertices[p],vertices[p+2]]=[vertices[p+2],vertices[p]];}
        };
        if(declaration) {
          const ptr=g2w(declaration),bytes=u32(ptr+16),seen=new Set();
          if(bytes<16 || bytes>136 || bytes%8)throw new Error('invalid vertex declaration length');
          for(let i=0;i<bytes/8-1;++i) {
            const p=ptr+24+i*8,offset=view.getUint16(p+2,true),type=view.getUint8(p+4),
              usage=view.getUint8(p+6),usageIndex=view.getUint8(p+7),key=`${usage}:${usageIndex}`;
            if(view.getUint16(p,true)!==0 || type>4 || view.getUint8(p+5)!==0 || seen.has(key))
              throw new Error('unsupported/duplicate vertex declaration element');
            seen.add(key);
            attributes.push({register:i,usage,usageIndex,type,offset});
            if(type===4)convertColor(offset);
          }
        } else {
        attributes.push({register:0,usage:0,usageIndex:0,type:position===2?2:3,offset:0});
        let offset=position===2?12:16;
        if(fvf&16){attributes.push({register:3,usage:3,usageIndex:0,type:2,offset});offset+=12;}
        for(const [bit,register,index] of [[64,5,0],[128,6,1]]) if(fvf&bit) {
          attributes.push({register,usage:10,usageIndex:index,type:4,offset});
          convertColor(offset);
          offset+=4;
        }
        for(let i=0;i<texCount;++i){const size=[2,3,4,1][(fvf>>>(16+i*2))&3];
          attributes.push({register:7+i,usage:5,usageIndex:i,type:size-1,offset});offset+=size*4;}
        if(offset>stride)throw new Error('FVF exceeds vertex stride');
        }
        const textures=[];
        for(let stage=0;stage<4;++stage){
          const ptr=u32(program+1700+stage*4);if(!ptr)continue;
          const t=g2w(ptr),levelCount=u32(t+32),format=u32(t+36),lod=u32(t+48),levels=[];
          if(levelCount>12 || lod>=levelCount || ![21,22].includes(format))throw new Error('invalid texture resource');
          for(let level=lod;level<levelCount;++level){const m=t+64+level*32,w=u32(m),h=u32(m+4);
            if(u32(m+20))throw new Error('cannot draw from locked texture');
            const src=new Uint8Array(memory,g2w(u32(m+16)),w*h*4),pixels=new Uint8Array(src.length);
            for(let i=0;i<src.length;i+=4){pixels[i]=src[i+2];pixels[i+1]=src[i+1];pixels[i+2]=src[i];pixels[i+3]=format===22?255:src[i+3];}
            levels.push({width:w,height:h,pixels});
          }
          const s=program+1808+stage*64;
          textures[stage]={...levels[0],levels,sampler:{addressU:u32(s+4),addressV:u32(s+8),
            mag:u32(s+20),min:u32(s+24),mip:u32(s+28)}};
        }
        device.draw({ primitive, primitiveCount, stride,
          vertices, indices, attributes, textures,
          vertexShader: shader(0), pixelShader: shader(4),
          vertexConstants: new Float32Array(memory,program+16,384).slice(),
          pixelConstants: new Float32Array(memory,program+1552,32).slice(),
          state: { zenable: !!rs(7), zwrite: !!rs(14), zfunc: rs(23), blend: !!rs(27),
            srcblend: rs(19), dstblend: rs(20), cull: rs(22) } });
        return 1;
      } catch (error) {
        this.lastError = error;
        if (this.options.onError) this.options.onError(error);
        return -1;
      }
    }
  }
  return { Bridge };
});
