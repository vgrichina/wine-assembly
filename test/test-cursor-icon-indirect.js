#!/usr/bin/env node

'use strict';

// CreateIconIndirect / CreateIconFromResourceEx / SetCursor for cursors the
// guest builds itself or decodes from Win9x resource bits.
//
// Heroes of Might & Magic II never calls LoadCursor: it draws its hand pointer
// into a pair of bitmaps and hands them to CreateIconIndirect. That used to be
// a return-constant stub handing back one fixed handle and dropping the
// bitmaps, so SetCursor fell through its IDC_* switch and the page kept the
// arrow. What this checks is the whole chain: distinct handles per cursor, the
// AND/XOR planes composited to the pixels the guest drew, the guest's own
// hotspot reaching the host, GetIconInfo answering with copies, and DestroyIcon
// freeing the slot.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { createHostImports } = require('../lib/host-imports');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

(async () => {
  const pushes = [];
  const opaqueCursors = [];
  // The real host import, wired to a canvas that only has a style -- which is
  // all a cursor needs. Calling it from the recording stub keeps this test on
  // the shipping encoder rather than on a description of it.
  let cssCanvas = null;
  let cssHost = null;
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      set_cursor_image: (hcur, width, height, hotX, hotY, bgraWa) => {
        if (cssHost) cssHost.host.set_cursor_image(hcur, width, height, hotX, hotY, bgraWa);
        const px = [];
        if (bgraWa) {
          const mem = new Uint8Array(harness.memory.buffer, bgraWa >>> 0, width * height * 4);
          for (let i = 0; i < width * height; i++) {
            px.push([mem[i * 4 + 2], mem[i * 4 + 1], mem[i * 4 + 0], mem[i * 4 + 3]]);
          }
        }
        pushes.push({ hcur: hcur >>> 0, width, height, hotX, hotY, pixels: px,
          hadBits: !!bgraWa, bgraWa: bgraWa >>> 0 });
      },
      set_cursor: hcur => opaqueCursors.push(hcur >>> 0),
    },
    extraWat: `
    (func (export "test_call_CreateIconIndirect") (param $info i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_CreateIconIndirect
        (local.get $info) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_CreateIconFromResourceEx")
          (param $bits i32) (param $size i32) (param $is_icon i32)
          (param $version i32) (param $cx i32) (param $cy i32)
          (param $flags i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $cy))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $flags))
      (call $handle_CreateIconFromResourceEx
        (local.get $bits) (local.get $size) (local.get $is_icon)
        (local.get $version) (local.get $cx) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_CreateIcon")
          (param $width i32) (param $height i32) (param $planes i32)
          (param $bits_pixel i32) (param $and_bits i32) (param $xor_bits i32)
          (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $and_bits))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $xor_bits))
      (call $handle_CreateIcon
        (i32.const 0) (local.get $width) (local.get $height)
        (local.get $planes) (local.get $bits_pixel) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_GetIconInfo") (param $icon i32) (param $info i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_GetIconInfo
        (local.get $icon) (local.get $info) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_SetCursor") (param $hcur i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_SetCursor
        (local.get $hcur) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_DestroyIcon") (param $icon i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_DestroyIcon
        (local.get $icon) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_CopyIcon") (param $icon i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_CopyIcon
        (local.get $icon) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_CopyImage")
          (param $image i32) (param $type i32) (param $cx i32)
          (param $cy i32) (param $flags i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_CopyImage
        (local.get $image) (local.get $type) (local.get $cx) (local.get $cy)
        (local.get $flags) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_DestroyCursor") (param $cursor i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_DestroyCursor
        (local.get $cursor) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_LoadCursorA") (param $hinst i32) (param $resid i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_LoadCursorA
        (local.get $hinst) (local.get $resid) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_bitmap_bpp") (param $bitmap i32) (result i32)
      (call $gdi_bitmap_record_bpp (call $gdi_object_record (local.get $bitmap))))
    (func (export "test_bitmap_flags") (param $bitmap i32) (result i32)
      (local $record i32)
      (local.set $record (call $gdi_object_record (local.get $bitmap)))
      (if (result i32) (local.get $record)
        (then (load.field.memarg GdiBitmap flags (local.get $record)))
        (else (i32.const 0))))
    (func (export "test_set_resource_root") (param $rva i32)
      (global.set $rsrc_rva (local.get $rva)))
    (func (export "test_intern_main_icon") (param $resid i32) (result i32)
      (call $icon_intern (i32.const 0) (local.get $resid)))
    (func (export "test_call_LoadIconA") (param $hinst i32) (param $resid i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_LoadIconA
        (local.get $hinst) (local.get $resid) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
  ` });
  const wat = harness.exports;
  wat.test_set_resource_root(0);
  cssCanvas = { style: {} };
  cssHost = createHostImports({
    getMemory: () => harness.memory.buffer,
    renderer: { canvas: cssCanvas },
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  });

  const alloc = size => wat.guest_alloc(size) >>> 0;
  const writeBytes = (ptr, bytes) => {
    for (let i = 0; i < bytes.length; i++) wat.guest_write8(ptr + i, bytes[i]);
  };

  // A W x H monochrome cursor as Win32 stores one: a 1bpp bitmap of height 2H,
  // AND plane over XOR plane. The rows are described here as strings so the
  // intended picture is readable -- '1' is a set bit.
  //   AND=0 XOR=0 -> opaque black, AND=0 XOR=1 -> opaque white,
  //   AND=1 XOR=0 -> transparent.
  const monoBitmap = (rows) => {
    const w = rows[0].length;
    const h = rows.length;
    const stride = ((w + 15) >> 4) << 1;   // DDB rows are WORD aligned
    const bytes = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rows[y][x] === '1') bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    const p = alloc(bytes.length);
    writeBytes(p, bytes);
    return wat.test_call_CreateBitmap(w, h, 1, 1, p) >>> 0;
  };

  const iconInfo = ({ fIcon = 0, xHot = 0, yHot = 0, mask = 0, color = 0 }) => {
    const p = alloc(20);
    wat.guest_write32(p + 0, fIcon);
    wat.guest_write32(p + 4, xHot);
    wat.guest_write32(p + 8, yHot);
    wat.guest_write32(p + 12, mask);
    wat.guest_write32(p + 16, color);
    return p;
  };

  // One classic Win9x 1-bpp RT_ICON/RT_CURSOR image. A cursor resource has a
  // four-byte LOCALHEADER before its BITMAPINFOHEADER; an icon resource does
  // not. The DIB height is XOR+AND (2H), and each plane is stored bottom-up in
  // DWORD-aligned scanlines.
  const resourceImage = ({ isIcon = false, xHot = 1, yHot = 2,
    andRows, xorRows }) => {
    const width = andRows[0].length;
    const height = andRows.length;
    const stride = ((width + 31) >> 5) << 2;
    const prefix = isIcon ? 0 : 4;
    const bytes = new Uint8Array(prefix + 40 + 8 + stride * height * 2);
    const dv = new DataView(bytes.buffer);
    if (!isIcon) {
      dv.setUint16(0, xHot, true);
      dv.setUint16(2, yHot, true);
    }
    const dib = prefix;
    dv.setUint32(dib + 0, 40, true);              // BITMAPINFOHEADER.biSize
    dv.setInt32(dib + 4, width, true);
    dv.setInt32(dib + 8, height * 2, true);       // XOR + AND
    dv.setUint16(dib + 12, 1, true);              // planes
    dv.setUint16(dib + 14, 1, true);              // monochrome
    dv.setUint32(dib + 16, 0, true);              // BI_RGB
    dv.setUint32(dib + 20, stride * height * 2, true);
    // RGBQUAD palette: black, white.
    bytes[dib + 40 + 4] = 255;
    bytes[dib + 40 + 5] = 255;
    bytes[dib + 40 + 6] = 255;
    const writePlane = (offset, rows) => {
      for (let y = 0; y < height; y++) {
        const row = rows[height - 1 - y];
        for (let x = 0; x < width; x++) {
          if (row[x] === '1') bytes[offset + y * stride + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    };
    const xorOffset = dib + 48;
    writePlane(xorOffset, xorRows);
    writePlane(xorOffset + stride * height, andRows);
    const ptr = alloc(bytes.length);
    writeBytes(ptr, bytes);
    return { ptr, size: bytes.length, width, height, bytes };
  };

  // Install one minimal PE resource tree with RT_GROUP_ICON 77 and two RT_ICON
  // images. Keeping the group in the mapped image makes this exercise the same
  // resource walker CopyImage uses for a real loaded executable.
  const installCopyImageResources = () => {
    const rsrcRva = 0x16000;
    const root = rsrcRva;
    const groupRva = 0x17000;
    const smallRva = 0x17100;
    const largeRva = 0x17200;
    for (let i = 0; i < 0x400; i++) wat.guest_write8(root + i, 0);
    const dir = (off, count) => wat.guest_write16(root + off + 14, count);
    const entry = (off, id, child, directory = true) => {
      wat.guest_write32(root + off, id);
      wat.guest_write32(root + off + 4, directory ? (0x80000000 | child) : child);
    };
    dir(0x000, 2);
    entry(0x010, 3, 0x040);       // RT_ICON
    entry(0x018, 14, 0x070);      // RT_GROUP_ICON
    dir(0x040, 2);
    entry(0x050, 1, 0x0a0);
    entry(0x058, 2, 0x0c0);
    dir(0x070, 1);
    entry(0x080, 77, 0x0e0);
    dir(0x0a0, 1);
    entry(0x0b0, 0x0409, 0x120, false);
    dir(0x0c0, 1);
    entry(0x0d0, 0x0409, 0x130, false);
    dir(0x0e0, 1);
    entry(0x0f0, 0x0409, 0x140, false);

    const black4 = Array(4).fill('0000');
    const largeAnd = ART_AND.flatMap(row => {
      const doubled = [...row].map(ch => ch + ch).join('');
      return [doubled, doubled];
    });
    const largeXor = ART_XOR.flatMap(row => {
      const doubled = [...row].map(ch => ch + ch).join('');
      return [doubled, doubled];
    });
    const small = resourceImage({ isIcon: true, andRows: black4, xorRows: black4 });
    const large = resourceImage({ isIcon: true, andRows: largeAnd, xorRows: largeXor });
    const group = new Uint8Array(6 + 2 * 14);
    const gdv = new DataView(group.buffer);
    gdv.setUint16(0, 0, true);
    gdv.setUint16(2, 1, true);
    gdv.setUint16(4, 2, true);
    const groupEntry = (off, width, height, size, id) => {
      group[off] = width;
      group[off + 1] = height;
      gdv.setUint16(off + 4, 1, true);
      gdv.setUint16(off + 6, 1, true);
      gdv.setUint32(off + 8, size, true);
      gdv.setUint16(off + 12, id, true);
    };
    groupEntry(6, 4, 4, small.size, 1);
    groupEntry(20, 8, 8, large.size, 2);
    writeBytes(groupRva, group);
    writeBytes(smallRva, small.bytes);
    writeBytes(largeRva, large.bytes);
    const dataEntry = (off, rva, size) => {
      wat.guest_write32(root + off, rva);
      wat.guest_write32(root + off + 4, size);
    };
    dataEntry(0x120, smallRva, small.size);
    dataEntry(0x130, largeRva, large.size);
    dataEntry(0x140, groupRva, group.length);
    wat.test_set_resource_root(rsrcRva);
  };

  // A 4x4 cursor that uses all four AND/XOR combinations exactly once per
  // corner, so a plane swap or a flipped row cannot pass. Stacked AND (top 4
  // rows) over XOR (bottom 4), which is how Win32 lays a mono mask out.
  //
  //   .WKK    (0,0) transparent  (1,0) white  (2,0) black
  //   KKKK
  //   WWWW
  //   KKKK    (3,3) AND=1 XOR=1 -- invert, which we draw as opaque black
  const ART_AND = [
    '1000',
    '0000',
    '0000',
    '0001',
  ];
  const ART_XOR = [
    '0100',
    '0000',
    '1111',
    '0001',
  ];
  const crossMask = () => monoBitmap(ART_AND.concat(ART_XOR));

  let resourceCursorA, resourceCursorB;

  check('CreateIcon honors BYTE-width planes and depth from Win9x OLEAUT', () => {
    const andBits = alloc(16);
    const xorBits = alloc(4 * 4 * 4);
    // OLEAUT reads the adjacent WORD fields of BITMAP in one dword. Native
    // USER32 sees cPlanes=1; a handler that consumes all 32 bits sees
    // 0x00200001 planes and rejects the allocation.
    const icon = wat.test_call_CreateIcon(
      4, 4, 0x00200001, 0x5a000020, andBits, xorBits) >>> 0;
    assert.ok(icon, 'packed high bits made CreateIcon return NULL');
    const info = alloc(20);
    assert.strictEqual(wat.test_call_GetIconInfo(icon, info) >>> 0, 1);
    assert.strictEqual(wat.guest_read32(info + 0) >>> 0, 1, 'fIcon');
    assert.ok(wat.guest_read32(info + 12) >>> 0, 'mask bitmap');
    assert.ok(wat.guest_read32(info + 16) >>> 0, '32bpp color bitmap');
  });

  check('CreateIconFromResourceEx creates distinct cursors from Win9x resource bits', () => {
    const a = resourceImage({ xHot: 1, yHot: 2, andRows: ART_AND, xorRows: ART_XOR });
    const b = resourceImage({ xHot: 3, yHot: 0, andRows: ART_AND, xorRows: ART_XOR });
    resourceCursorA = wat.test_call_CreateIconFromResourceEx(
      a.ptr, a.size, 0, 0x00030000, 0, 0, 0) >>> 0;
    resourceCursorB = wat.test_call_CreateIconFromResourceEx(
      b.ptr, b.size, 0, 0x00030000, 0, 0, 0) >>> 0;
    assert.ok(resourceCursorA, 'first resource cursor is zero');
    assert.ok(resourceCursorB, 'second resource cursor is zero');
    assert.notStrictEqual(resourceCursorA, resourceCursorB, 'resource cursors shared one handle');
    assert.strictEqual(resourceCursorA & 0xFFFF0000, 0x00CC0000);
    assert.notStrictEqual(resourceCursorA, 0xCAFE0001, 'old fixed handle survived');
  });

  check('resource cursor pixels and LOCALHEADER hotspot reach the browser host', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(resourceCursorA);
    assert.strictEqual(pushes.length, 1, 'resource cursor was not presented');
    const p = pushes[0];
    assert.deepStrictEqual(
      { width: p.width, height: p.height, hotX: p.hotX, hotY: p.hotY },
      { width: 4, height: 4, hotX: 1, hotY: 2 });
    const at = (x, y) => p.pixels[y * 4 + x];
    assert.deepStrictEqual(at(0, 0), [0, 0, 0, 0], 'transparent resource pixel');
    assert.deepStrictEqual(at(1, 0), [255, 255, 255, 255], 'white resource pixel');
    assert.deepStrictEqual(at(2, 0), [0, 0, 0, 255], 'black resource pixel');
  });

  check('requested resource size and cursor hotspot are scaled together', () => {
    const image = resourceImage({ xHot: 1, yHot: 2, andRows: ART_AND, xorRows: ART_XOR });
    const scaled = wat.test_call_CreateIconFromResourceEx(
      image.ptr, image.size, 0, 0x00030000, 8, 8, 0) >>> 0;
    assert.ok(scaled, 'scaled cursor is zero');
    pushes.length = 0;
    wat.test_call_SetCursor(scaled);
    assert.deepStrictEqual(
      { width: pushes[0].width, height: pushes[0].height,
        hotX: pushes[0].hotX, hotY: pushes[0].hotY },
      { width: 8, height: 8, hotX: 2, hotY: 4 });
  });

  check('resource icons report icon identity and a centered hotspot', () => {
    const image = resourceImage({ isIcon: true, andRows: ART_AND, xorRows: ART_XOR });
    const icon = wat.test_call_CreateIconFromResourceEx(
      image.ptr, image.size, 1, 0x00030000, 8, 8, 0) >>> 0;
    assert.ok(icon, 'resource icon is zero');
    const info = alloc(20);
    assert.strictEqual(wat.test_call_GetIconInfo(icon, info) >>> 0, 1);
    assert.strictEqual(wat.guest_read32(info + 0) >>> 0, 1, 'fIcon');
    assert.strictEqual(wat.guest_read32(info + 4) >>> 0, 4, 'center x');
    assert.strictEqual(wat.guest_read32(info + 8) >>> 0, 4, 'center y');
    assert.ok(wat.guest_read32(info + 12) >>> 0, 'mask bitmap');
  });

  check('CopyImage stretches the loaded icon or reloads the nearest group entry', () => {
    installCopyImageResources();
    assert.ok(wat.rsrc_find_data_wa(14, 77) >>> 0, 'test RT_GROUP_ICON is not findable');
    assert.ok(wat.rsrc_find_data_wa(3, 1) >>> 0, 'test RT_ICON is not findable');
    const source = wat.test_intern_main_icon(77) >>> 0;
    assert.ok(source, 'test module icon did not intern');
    assert.strictEqual(wat.test_call_CopyImage(source, 1, 0, 0, 0x0004) >>> 0, source,
      'LR_COPYRETURNORG missed the loaded first-entry dimensions');

    const stretched = wat.test_call_CopyImage(source, 1, 7, 7, 0) >>> 0;
    const reloaded = wat.test_call_CopyImage(source, 1, 7, 7, 0x4000) >>> 0;
    assert.ok(stretched && reloaded, 'resource CopyImage returned NULL');
    pushes.length = 0;
    wat.test_call_SetCursor(stretched);
    const stretchedPush = pushes[pushes.length - 1];
    pushes.length = 0;
    wat.test_call_SetCursor(reloaded);
    const reloadedPush = pushes[pushes.length - 1];
    assert.deepStrictEqual(
      { width: stretchedPush.width, height: stretchedPush.height },
      { width: 7, height: 7 });
    assert.deepStrictEqual(
      { width: reloadedPush.width, height: reloadedPush.height },
      { width: 7, height: 7 });
    const whitePixels = push => push.pixels.filter(
      px => px[0] > 200 && px[1] > 200 && px[2] > 200 && px[3] > 200).length;
    assert.strictEqual(whitePixels(stretchedPush), 0,
      'ordinary CopyImage did not stretch the current first group image');
    assert.ok(whitePixels(reloadedPush) > 0,
      'LR_COPYFROMRESOURCE did not choose the closer 8x8 image');
    wat.test_call_DestroyIcon(stretched);
    wat.test_call_DestroyIcon(reloaded);
  });

  check('invalid resource versions and truncated DIBs fail instead of succeeding silently', () => {
    const image = resourceImage({ andRows: ART_AND, xorRows: ART_XOR });
    assert.strictEqual(wat.test_call_CreateIconFromResourceEx(
      image.ptr, image.size, 0, 0x00010000, 0, 0, 0) >>> 0, 0, 'old version accepted');
    assert.strictEqual(wat.test_call_CreateIconFromResourceEx(
      image.ptr, image.size - 1, 0, 0x00030000, 0, 0, 0) >>> 0, 0, 'truncation accepted');
  });

  check('DestroyIcon invalidates exactly one resource-created handle', () => {
    assert.strictEqual(wat.test_call_DestroyIcon(resourceCursorA) >>> 0, 1);
    const info = alloc(20);
    for (let i = 0; i < 20; i += 4) wat.guest_write32(info + i, 0xdeadbeef | 0);
    wat.test_call_GetIconInfo(resourceCursorA, info);
    assert.strictEqual(wat.guest_read32(info + 12) >>> 0, 0, 'destroyed resource cursor stayed live');
    assert.strictEqual(wat.test_call_GetIconInfo(resourceCursorB, info) >>> 0, 1,
      'destroying one resource cursor invalidated another');
  });

  let handleA, handleB;

  check('CreateIconIndirect returns a distinct non-zero handle per cursor', () => {
    handleA = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 1, yHot: 2, mask: crossMask() })) >>> 0;
    handleB = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 3, yHot: 0, mask: crossMask() })) >>> 0;
    assert.ok(handleA !== 0, 'first handle is zero');
    assert.ok(handleB !== 0, 'second handle is zero');
    assert.notStrictEqual(handleA, handleB, 'two cursors shared one handle');
    assert.strictEqual(handleA & 0xFFFF0000, 0x00CC0000, 'handle is not tagged as a cursor');
  });

  check('CreateIconIndirect rejects a NULL ICONINFO', () => {
    assert.strictEqual(wat.test_call_CreateIconIndirect(0) >>> 0, 0);
  });

  check('SetCursor pushes the composited pixels the guest drew', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(pushes.length, 1, 'no cursor image reached the host');
    const p = pushes[0];
    assert.strictEqual(p.hcur, handleA);
    assert.strictEqual(p.width, 4, 'width');
    assert.strictEqual(p.height, 4, 'height: the mask is 2H tall, the cursor is H');
    assert.ok(p.hadBits, 'first push carried no pixels');
    const at = (x, y) => p.pixels[y * 4 + x];
    // Print what was composited: a wrong row or plane order is a picture
    // problem, and a diff of two [r,g,b,a] tuples cannot show it.
    for (let y = 0; y < 4; y++) {
      let line = '';
      for (let x = 0; x < 4; x++) {
        const px = at(x, y);
        line += px[3] === 0 ? '.' : (px[0] > 127 ? 'W' : 'K');
      }
      console.log(`      ${line}`);
    }
    assert.deepStrictEqual(at(0, 0), [0, 0, 0, 0], 'AND=1 XOR=0 is not transparent');
    assert.deepStrictEqual(at(1, 0), [255, 255, 255, 255], 'AND=0 XOR=1 is not white');
    assert.deepStrictEqual(at(2, 0), [0, 0, 0, 255], 'AND=0 XOR=0 is not opaque black');
    assert.deepStrictEqual(at(3, 3), [0, 0, 0, 255], 'AND=1 XOR=1 (invert) is not drawn');
    assert.ok(p.pixels.some(px => px[3] !== 0), 'cursor rasterized to nothing at all');
  });

  check('the hotspot reaching the host is the guest\'s own', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(handleB);
    assert.strictEqual(pushes[0].hotX, 3);
    assert.strictEqual(pushes[0].hotY, 0);
    pushes.length = 0;
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(pushes[0].hotX, 1);
    assert.strictEqual(pushes[0].hotY, 2);
  });

  check('re-selecting a cursor costs no second rasterization', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(handleA);
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(pushes.length, 2, 'the host is not told about every selection');
    assert.strictEqual(pushes[1].hadBits, false,
      'pixels were re-sent for a cursor the host already has');
  });

  check('SetCursor returns the previous cursor', () => {
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(wat.test_call_SetCursor(handleB) >>> 0, handleA);
  });

  check('GetIconInfo reports the record back, with its own bitmap copies', () => {
    const info = alloc(20);
    for (let i = 0; i < 20; i += 4) wat.guest_write32(info + i, 0);
    assert.notStrictEqual(wat.test_call_GetIconInfo(handleA, info) >>> 0, 0, 'returned FALSE');
    assert.strictEqual(wat.guest_read32(info + 0) >>> 0, 0, 'fIcon: a cursor, not an icon');
    assert.strictEqual(wat.guest_read32(info + 4) >>> 0, 1, 'xHotspot');
    assert.strictEqual(wat.guest_read32(info + 8) >>> 0, 2, 'yHotspot');
    const mask = wat.guest_read32(info + 12) >>> 0;
    assert.ok(mask !== 0, 'no mask bitmap handed back');
    // The caller owns what GetIconInfo returns, so it must not be our own
    // bitmap -- deleting it would gut the cursor.
    pushes.length = 0;
    wat.test_call_SetCursor(handleB);
    wat.test_call_SetCursor(handleA);
    assert.ok(pushes.length >= 1, 'cursor stopped being presentable');
  });

  check('the host presents it as a .cur data URL with the guest\'s hotspot', () => {
    wat.test_call_SetCursor(handleB);
    wat.test_call_SetCursor(handleA);
    const css = cssCanvas.style.cursor || '';
    assert.ok(/^url\(data:image\/x-icon;base64,[A-Za-z0-9+/=]+\) 1 2, default$/.test(css),
      `canvas.style.cursor is ${JSON.stringify(css)}`);
    const cur = Buffer.from(css.slice(css.indexOf(',') + 1, css.indexOf(')')), 'base64');
    const dv = new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
    assert.strictEqual(dv.getUint16(2, true), 2, 'idType: a cursor, not an icon');
    assert.strictEqual(cur[6], 4, 'ICONDIRENTRY width');
    assert.strictEqual(cur[7], 4, 'ICONDIRENTRY height');
    assert.strictEqual(dv.getUint16(10, true), 1, 'hotspot x');
    assert.strictEqual(dv.getUint16(12, true), 2, 'hotspot y');
    assert.strictEqual(dv.getUint16(36, true), 32, 'biBitCount: 32bpp, so alpha survives');
    assert.strictEqual(dv.getInt32(30, true), 8, 'biHeight covers colour + mask');
    // DIB rows run bottom-up, so the picture's top row is the last one here.
    const topRow = 62 + 3 * 4 * 4;
    assert.strictEqual(cur[topRow + 3], 0, 'the transparent corner became opaque');
    assert.strictEqual(cur[topRow + 4 + 3], 255, 'the white pixel lost its alpha');
    assert.strictEqual(cur[topRow + 4 + 0], 255, 'the white pixel is not white');
  });

  // Measured on Safari 26.4 with tools/ios-lab/cursor-decode.html: an <img>
  // refuses a `data:image/x-icon` outright, and a .cur set on style.cursor is
  // kept as a string but never drawn. lib/touch-cursor.js paints the guest's
  // art onto the phone sprite through an <img>, so the wrapper that is
  // perfectly good in Chrome is invisible on the device the sprite exists
  // for. Where there is a canvas to encode with, the cursor goes out as PNG.
  check('a browser gets the same cursor as a PNG, pixels intact', () => {
    const drawn = [];
    const fakeDocument = {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: image => drawn.push(image),
        }),
        toDataURL: () => 'data:image/png;base64,SENTINEL',
      }),
    };
    const previous = global.document;
    global.document = fakeDocument;
    let css;
    try {
      const canvas = { style: {} };
      const host = createHostImports({
        getMemory: () => harness.memory.buffer,
        renderer: { canvas },
        resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
        onExit: () => {},
      });
      // A cursor of its own: WAT hands the pixels over once per handle, so
      // the scratch behind an earlier push has since been rasterized over.
      pushes.length = 0;
      const fresh = wat.test_call_CreateIconIndirect(
        iconInfo({ xHot: 1, yHot: 2, mask: crossMask() })) >>> 0;
      wat.test_call_SetCursor(fresh);
      const push = pushes.find(entry => entry.hadBits && entry.hcur === fresh);
      assert.ok(push, 'no cursor was ever pushed to take pixels from');
      host.host.set_cursor_image(fresh, push.width, push.height, 1, 2, push.bgraWa);
      css = canvas.style.cursor || '';
    } finally {
      if (previous === undefined) delete global.document; else global.document = previous;
    }
    assert.strictEqual(css, 'url(data:image/png;base64,SENTINEL) 1 2, default',
      `a browser cursor came out as ${JSON.stringify(css.slice(0, 40))}`);
    assert.ok(drawn.length, 'nothing was written into the PNG canvas');
    // BGRA in, RGBA out -- the white pixel of the art must stay white rather
    // than coming back as some channel-swapped near-black.
    const data = drawn[drawn.length - 1].data;
    assert.strictEqual(data[3], 0, 'the transparent corner became opaque');
    assert.deepStrictEqual([data[4], data[5], data[6], data[7]], [255, 255, 255, 255],
      'the white pixel did not survive the BGRA -> RGBA swap');
  });

  check('DestroyIcon frees the slot and the handle stops resolving', () => {
    assert.notStrictEqual(wat.test_call_DestroyIcon(handleA) >>> 0, 0, 'returned FALSE');
    const info = alloc(20);
    for (let i = 0; i < 20; i += 4) wat.guest_write32(info + i, 0xdeadbeef | 0);
    wat.test_call_GetIconInfo(handleA, info);
    assert.strictEqual(wat.guest_read32(info + 12) >>> 0, 0,
      'a destroyed cursor still reports a mask bitmap');
    // ... and the freed slot is handed to the next cursor.
    const again = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 2, yHot: 2, mask: crossMask() })) >>> 0;
    assert.strictEqual(again, handleA, 'the freed slot was not reused');
  });

  check('CopyImage creates and resamples an independent bitmap', () => {
    const bits = alloc(16);
    for (let i = 0; i < 4; i++) wat.guest_write32(bits + i * 4, 0x00112233);
    const source = wat.test_call_CreateBitmap(2, 2, 1, 32, bits) >>> 0;
    const copy = wat.test_call_CopyImage(source, 0, 4, 3, 0) >>> 0;
    assert.ok(copy, 'bitmap CopyImage returned NULL');
    assert.notStrictEqual(copy, source, 'bitmap CopyImage returned the source');
    assert.strictEqual(wat.test_gdi_object_width(copy), 4, 'scaled bitmap width');
    assert.strictEqual(wat.test_gdi_object_height(copy), 3, 'scaled bitmap height');
    assert.strictEqual(wat.test_bitmap_bpp(copy), 32, 'bitmap depth changed');
    assert.strictEqual(wat.test_gdi_object_type(source), 3, 'copy consumed its source');
    const storage = wat.test_gdi_bitmap_storage(copy) >>> 0;
    const dv = new DataView(harness.memory.buffer);
    const first = dv.getUint32(storage, true) & 0x00ffffff;
    assert.notStrictEqual(first, 0, 'scaled bitmap lost its pixels');
    for (let i = 1; i < 12; i++) {
      assert.strictEqual(dv.getUint32(storage + i * 4, true) & 0x00ffffff, first,
        `scaled bitmap pixel ${i}`);
    }
    wat.test_call_DeleteObject(source);
    wat.test_call_DeleteObject(copy);
  });

  check('CopyImage honors RETURNORG and deletes only after a successful copy', () => {
    const bits = alloc(16);
    for (let i = 0; i < 4; i++) wat.guest_write32(bits + i * 4, 0x00554433);
    const source = wat.test_call_CreateBitmap(2, 2, 1, 32, bits) >>> 0;
    const same = wat.test_call_CopyImage(source, 0, 0, 0, 0x000c) >>> 0;
    assert.strictEqual(same, source, 'LR_COPYRETURNORG did not preserve identity');
    assert.strictEqual(wat.test_gdi_object_type(source), 3,
      'LR_COPYDELETEORG was not ignored on RETURNORG');
    const copy = wat.test_call_CopyImage(source, 0, 3, 3, 0x0008) >>> 0;
    assert.ok(copy && copy !== source, 'LR_COPYDELETEORG made no new bitmap');
    assert.strictEqual(wat.test_gdi_object_type(source), 0,
      'LR_COPYDELETEORG left the source bitmap live');
    assert.strictEqual(wat.test_gdi_object_type(copy), 3, 'new bitmap was also deleted');
    wat.test_call_DeleteObject(copy);
  });

  check('CopyImage creates requested monochrome and DIB-section bitmaps', () => {
    const bits = alloc(16);
    wat.guest_write32(bits + 0, 0x00000000);
    wat.guest_write32(bits + 4, 0x00ffffff);
    wat.guest_write32(bits + 8, 0x00ffffff);
    wat.guest_write32(bits + 12, 0x00000000);
    const source = wat.test_call_CreateBitmap(2, 2, 1, 32, bits) >>> 0;
    const mono = wat.test_call_CopyImage(source, 0, 0, 0, 0x0001) >>> 0;
    const dib = wat.test_call_CopyImage(source, 0, 0, 0, 0x2000) >>> 0;
    assert.ok(mono && dib, 'format-selecting CopyImage returned NULL');
    assert.strictEqual(wat.test_bitmap_bpp(mono), 1, 'LR_MONOCHROME kept color depth');
    assert.strictEqual(wat.test_bitmap_flags(mono) & 1, 0, 'monochrome copy became a DIB');
    assert.strictEqual(wat.test_bitmap_bpp(dib), 32, 'DIB copy changed color depth');
    assert.strictEqual(wat.test_bitmap_flags(dib) & 1, 1,
      'LR_CREATEDIBSECTION did not create a DIB section');
    wat.test_call_DeleteObject(source);
    wat.test_call_DeleteObject(mono);
    wat.test_call_DeleteObject(dib);
  });

  check('CopyImage scales built icons and keeps the copy alive independently', () => {
    const source = wat.test_call_CreateIconIndirect(
      iconInfo({ fIcon: 1, xHot: 2, yHot: 2, mask: crossMask() })) >>> 0;
    const copy = wat.test_call_CopyImage(source, 1, 8, 6, 0) >>> 0;
    assert.ok(copy && copy !== source, 'scaled icon copy was not independent');
    const info = alloc(20);
    assert.strictEqual(wat.test_call_GetIconInfo(copy, info) >>> 0, 1);
    assert.strictEqual(wat.guest_read32(info + 0) >>> 0, 1, 'copy changed icon type');
    assert.strictEqual(wat.guest_read32(info + 4) >>> 0, 4, 'icon hotspot x');
    assert.strictEqual(wat.guest_read32(info + 8) >>> 0, 3, 'icon hotspot y');
    const mask = wat.guest_read32(info + 12) >>> 0;
    assert.strictEqual(wat.test_gdi_object_width(mask), 8, 'icon mask width');
    assert.strictEqual(wat.test_gdi_object_height(mask), 12, 'stacked icon mask height');
    assert.strictEqual(wat.test_call_CopyImage(source, 2, 8, 6, 0) >>> 0, 0,
      'IMAGE_CURSOR accepted an icon');
    assert.strictEqual(wat.test_call_DestroyIcon(source) >>> 0, 1);
    assert.strictEqual(wat.test_call_GetIconInfo(copy, info) >>> 0, 1,
      'destroying the source destroyed its CopyImage result');
    assert.strictEqual(wat.test_call_DestroyIcon(copy) >>> 0, 1);
  });

  check('CopyImage scales cursor hotspots and COPYDELETEORG lifetime', () => {
    const source = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 1, yHot: 2, mask: crossMask() })) >>> 0;
    const returned = wat.test_call_CopyImage(source, 2, 0, 0, 0x000c) >>> 0;
    assert.strictEqual(returned, source, 'cursor LR_COPYRETURNORG changed identity');
    const copy = wat.test_call_CopyImage(source, 2, 8, 8, 0x0008) >>> 0;
    assert.ok(copy && copy !== source, 'scaled cursor copy failed');
    const info = alloc(20);
    wat.test_call_GetIconInfo(source, info);
    assert.strictEqual(wat.guest_read32(info + 12) >>> 0, 0,
      'LR_COPYDELETEORG left the cursor source bitmaps live');
    pushes.length = 0;
    wat.test_call_SetCursor(copy);
    assert.deepStrictEqual(
      { width: pushes[0].width, height: pushes[0].height,
        hotX: pushes[0].hotX, hotY: pushes[0].hotY },
      { width: 8, height: 8, hotX: 2, hotY: 4 });
    assert.strictEqual(wat.test_call_DestroyCursor(copy) >>> 0, 1);
    assert.strictEqual(wat.test_call_DestroyCursor(copy) >>> 0, 0,
      'destroyed cursor copy stayed valid');
  });

  check('LR_MONOCHROME turns a color icon into owned AND/XOR planes', () => {
    const andBits = alloc(8);
    const xorBits = alloc(64);
    for (let i = 0; i < 16; i++) {
      wat.guest_write32(xorBits + i * 4, (i & 1) ? 0x00ffffff : 0x00000000);
    }
    const source = wat.test_call_CreateIcon(4, 4, 1, 32, andBits, xorBits) >>> 0;
    const copy = wat.test_call_CopyImage(source, 1, 4, 4, 0x0001) >>> 0;
    assert.ok(copy, 'color-to-monochrome icon copy returned NULL');
    const info = alloc(20);
    assert.strictEqual(wat.test_call_GetIconInfo(copy, info) >>> 0, 1);
    const mask = wat.guest_read32(info + 12) >>> 0;
    assert.ok(mask, 'monochrome icon has no mask');
    assert.strictEqual(wat.guest_read32(info + 16) >>> 0, 0,
      'monochrome icon retained a color bitmap');
    assert.strictEqual(wat.test_bitmap_bpp(mask), 1, 'monochrome mask is not 1bpp');
    assert.strictEqual(wat.test_gdi_object_height(mask), 8, 'AND/XOR planes are not stacked');
    wat.test_call_DestroyIcon(source);
    wat.test_call_DestroyIcon(copy);
  });

  check('opaque LoadCursor copies remain drawable and privately destroyable', () => {
    const source = wat.test_call_LoadCursorA(0, 32512) >>> 0;
    const copy = wat.test_call_CopyImage(source, 2, 0, 0, 0) >>> 0;
    assert.ok(copy && copy !== source, 'shared cursor was returned instead of copied');
    opaqueCursors.length = 0;
    wat.test_call_SetCursor(copy);
    assert.deepStrictEqual(opaqueCursors, [source], 'private cursor wrapper was not unwrapped');
    assert.strictEqual(wat.test_call_DestroyCursor(copy) >>> 0, 1);
    assert.strictEqual(wat.test_call_DestroyCursor(copy) >>> 0, 0);
    assert.strictEqual(wat.test_call_CopyImage(source, 2, 16, 16, 0) >>> 0, 0,
      'opaque cursor claimed unsupported resized pixels');
  });

  check('CopyImage rejects NULL handles and unknown image types', () => {
    assert.strictEqual(wat.test_call_CopyImage(0, 0, 0, 0, 0) >>> 0, 0);
    assert.strictEqual(wat.test_call_CopyImage(0x1234, 3, 0, 0, 0) >>> 0, 0);
  });

  check('CopyIcon owns independent bitmap planes and lifetime', () => {
    const source = wat.test_call_CreateIconIndirect(
      iconInfo({ fIcon: 1, xHot: 2, yHot: 2, mask: crossMask() })) >>> 0;
    const copy = wat.test_call_CopyIcon(source) >>> 0;
    assert.ok(copy, 'CopyIcon returned NULL for a built icon');
    assert.notStrictEqual(copy, source, 'CopyIcon returned the source handle');
    assert.strictEqual(wat.test_call_DestroyIcon(source) >>> 0, 1);
    const info = alloc(20);
    assert.strictEqual(wat.test_call_GetIconInfo(copy, info) >>> 0, 1);
    assert.ok(wat.guest_read32(info + 12) >>> 0,
      'destroying the source also destroyed the copy mask');
    assert.strictEqual(wat.test_call_DestroyIcon(copy) >>> 0, 1);
    assert.strictEqual(wat.test_call_DestroyIcon(copy) >>> 0, 0,
      'a copied icon stayed valid after destruction');
  });

  check('CopyIcon wraps shared resource and opaque system icons privately', () => {
    const resource = wat.test_call_LoadIconA(0x400000, 1) >>> 0;
    const resourceCopy = wat.test_call_CopyIcon(resource) >>> 0;
    assert.ok(resourceCopy && resourceCopy !== resource,
      'resource CopyIcon did not return a distinct handle');
    assert.strictEqual(wat.test_call_DestroyIcon(resourceCopy) >>> 0, 1);
    assert.strictEqual(wat.test_call_DestroyIcon(resourceCopy) >>> 0, 0);
    assert.ok(wat.test_call_CopyIcon(resource) >>> 0,
      'destroying a resource copy invalidated the shared source');

    const system = wat.test_call_LoadIconA(0, 32512) >>> 0;
    const systemCopy = wat.test_call_CopyIcon(system) >>> 0;
    assert.ok(systemCopy && systemCopy !== system,
      'opaque system CopyIcon did not return a private handle');
    assert.strictEqual(wat.test_call_DestroyIcon(systemCopy) >>> 0, 1);
    assert.strictEqual(wat.test_call_CopyIcon(0) >>> 0, 0,
      'CopyIcon accepted NULL');
  });

  console.log(`\n${passed} checks passed`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
