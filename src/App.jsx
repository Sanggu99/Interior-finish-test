import React, { useState, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { env, pipeline, RawImage } from '@xenova/transformers';
import { UploadCloud, Loader2, Image as ImageIcon, PaintBucket } from 'lucide-react';
import './App.css';

env.allowLocalModels = false;

// Korean Interior Design Materials
const MATERIALS = {
  wall: [
    { id: 'wall-paint', name: '화이트 도장', color: '#FAFAFA', type: 'color' },
    { id: 'wall-plaster', name: '석고보드 (Plaster)', image: '/textures/plasterboard.png', type: 'texture' },
    { id: 'wall-brick', name: '붉은 벽돌 (Brick)', image: '/textures/brick.png', type: 'texture' },
    { id: 'wall-panel', name: '우드 패널 (Panel)', image: '/textures/panel.png', type: 'texture' },
    { id: 'wall-concrete', name: '콘크리트 (Concrete)', image: '/textures/concrete.png', type: 'texture' },
  ],
  floor: [
    { id: 'floor-oak', name: '오크 원목 (Wood)', image: '/textures/wood.png', type: 'texture' },
    { id: 'floor-concrete', name: '콘크리트 (Concrete)', image: '/textures/concrete.png', type: 'texture' },
    { id: 'tile-gray', name: '그레이 타일', color: '#B0B5B9', type: 'color' },
  ],
  ceiling: [
    { id: 'ceiling-white', name: '화이트 천장지', color: '#FFFFFF', type: 'color' },
    { id: 'ceiling-concrete', name: '콘크리트', image: '/textures/concrete.png', type: 'texture' },
    { id: 'ceiling-wood', name: '우드 패널', image: '/textures/panel.png', type: 'texture' }
  ]
};

function App() {
  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [segments, setSegments] = useState([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState(null);
  const [appliedMaterials, setAppliedMaterials] = useState({}); // { label: materialObject }
  const [texturesLoaded, setTexturesLoaded] = useState(false);

  const canvasRef = useRef(null);
  const displayCanvasRef = useRef(null);
  const textureImagesRef = useRef({});

  useEffect(() => {
    // Preload texture images
    const allTextures = [...MATERIALS.wall, ...MATERIALS.floor, ...MATERIALS.ceiling]
      .filter(m => m.type === 'texture')
      .map(m => m.image);

    const uniqueTextures = [...new Set(allTextures)];
    let loadedCount = 0;

    if (uniqueTextures.length === 0) {
      setTexturesLoaded(true);
      return;
    }

    uniqueTextures.forEach(src => {
      const img = new Image();
      img.src = src;
      img.onload = () => {
        textureImagesRef.current[src] = img;
        loadedCount++;
        if (loadedCount === uniqueTextures.length) {
          setTexturesLoaded(true);
        }
      };
      img.onerror = () => {
        // Ignore error
        loadedCount++;
        if (loadedCount === uniqueTextures.length) {
          setTexturesLoaded(true);
        }
      };
    });
  }, []);

  const { getRootProps, getInputProps } = useDropzone({
    accept: { 'image/*': [] },
    onDrop: async (acceptedFiles) => {
      if (acceptedFiles.length > 0) {
        const file = acceptedFiles[0];
        const url = URL.createObjectURL(file);
        setImage(url);
        setSegments([]);
        setAppliedMaterials({});
        setSelectedSegmentId(null);
        await handleImageProcess(url);
      }
    }
  });

  const handleImageProcess = async (imageUrl) => {
    setLoading(true);
    setProgress('모델을 불러오는 중입니다... (최초 1회)');
    try {
      const segmenter = await pipeline(
        'image-segmentation',
        'Xenova/segformer-b2-finetuned-ade-512-512',
        {
          progress_callback: (info) => {
            if (info.status === 'downloading') {
              setProgress(`모델 다운로드 중: ${Math.round(info.progress || 0)}%`);
            } else if (info.status === 'ready') {
              setProgress('모델 준비 완료! 이미지 분석 중...');
            }
          }
        }
      );

      setProgress('공간을 시맨틱 세그멘테이션으로 분리하는 중입니다...');
      const output = await segmenter(imageUrl);

      // Filter for interesting categories (wall, floor, ceiling)
      const targetLabels = ['wall', 'floor', 'ceiling'];
      const filtered = output.filter(seg => targetLabels.some(l => seg.label.includes(l)));

      // Normalize labels and encode masks to data URLs for CSS
      const normalizedSegs = filtered.map(seg => {
        let labelKey = 'wall';
        if (seg.label.includes('floor') || seg.label.includes('flooring')) labelKey = 'floor';
        if (seg.label.includes('ceiling')) labelKey = 'ceiling';

        const width = seg.mask.width;
        const height = seg.mask.height;
        let minX = width, maxX = 0;

        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = width;
        tmpCanvas.height = height;
        const tmpCtx = tmpCanvas.getContext('2d');
        const imgData = tmpCtx.createImageData(width, height);

        for (let i = 0; i < seg.mask.data.length; i++) {
          if (seg.mask.data[i] > 0) {
            imgData.data[i * 4] = 0;
            imgData.data[i * 4 + 1] = 0;
            imgData.data[i * 4 + 2] = 0;
            imgData.data[i * 4 + 3] = 255;

            let x = i % width;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }

        const blurCanvas = document.createElement('canvas');
        blurCanvas.width = width;
        blurCanvas.height = height;
        const blurCtx = blurCanvas.getContext('2d');
        blurCtx.putImageData(imgData, 0, 0);

        tmpCtx.filter = 'blur(2px)';
        tmpCtx.drawImage(blurCanvas, 0, 0);

        const maskDataUrl = tmpCanvas.toDataURL('image/png');

        // Auto perspective calculation based on bounding box
        const cx = (minX + maxX) / 2;
        let autoTransform = 'scale(1)';
        const perspectiveParam = '1200px';

        if (labelKey === 'floor') {
          autoTransform = `perspective(${perspectiveParam}) rotateX(60deg) scale(2.5)`;
        } else if (labelKey === 'ceiling') {
          autoTransform = `perspective(${perspectiveParam}) rotateX(-60deg) scale(2.5)`;
        } else if (labelKey === 'wall') {
          if (cx < width * 0.4) {
            autoTransform = `perspective(${perspectiveParam}) rotateY(55deg) scale(2)`;
          } else if (cx > width * 0.6) {
            autoTransform = `perspective(${perspectiveParam}) rotateY(-55deg) scale(2)`;
          } else {
            autoTransform = 'scale(1.2)';
          }
        }

        return { ...seg, labelKey, maskDataUrl, autoTransform };
      });

      setSegments(normalizedSegs);
      setProgress('');
    } catch (err) {
      console.error(err);
      setProgress('이미지 처리 중 오류가 발생했습니다. 브라우저가 지원하지 않을 수 있습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleImageClick = (e) => {
    if (!image || segments.length === 0) return;
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let clickedIdx = null;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const maskX = Math.floor((x / rect.width) * seg.mask.width);
      const maskY = Math.floor((y / rect.height) * seg.mask.height);
      const val = seg.mask.data[maskY * seg.mask.width + maskX];

      if (val > 0) {
        clickedIdx = i;
        break;
      }
    }

    if (clickedIdx !== null) {
      setSelectedSegmentId(clickedIdx);
    } else {
      setSelectedSegmentId(null);
    }
  };

  const applyMaterial = (material) => {
    if (selectedSegmentId !== null) {
      setAppliedMaterials(prev => ({
        ...prev,
        [selectedSegmentId]: material
      }));
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>공간 AI 스타일링</h1>
        <p>투시도나 사진의 벽, 바닥, 천장 재질을 한국 인기 마감재로 바꿔보세요.</p>
      </header>

      <main className="app-main">
        <div className="canvas-area">
          {!image ? (
            <div {...getRootProps()} className={`dropzone ${loading ? 'loading' : ''}`}>
              <input {...getInputProps()} />
              <UploadCloud size={64} className="upload-icon" />
              <p>투시도 또는 실내 사진을 드래그하거나 클릭하여 업로드하세요</p>
              <span className="subtitle">지원 확장자: JPG, PNG</span>
            </div>
          ) : (
            <div className="canvas-wrapper" style={{ position: 'relative', display: 'inline-block' }}>
              <img
                src={image}
                alt="Interior"
                className="main-canvas"
                onClick={handleImageClick}
                draggable={false}
                style={{ cursor: segments.length > 0 ? 'pointer' : 'default', display: 'block' }}
              />

              {segments.map((seg, idx) => {
                const isSelected = selectedSegmentId === idx;
                const appliedMat = appliedMaterials[idx];

                if (!isSelected && !appliedMat) return null;

                return (
                  <div key={idx} style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    pointerEvents: 'none',
                    WebkitMaskImage: `url(${seg.maskDataUrl})`,
                    WebkitMaskSize: '100% 100%',
                    maskImage: `url(${seg.maskDataUrl})`,
                    maskSize: '100% 100%',
                    mixBlendMode: appliedMat ? 'multiply' : 'normal',
                    zIndex: isSelected ? 10 : 5,
                    overflow: 'hidden'
                  }}>
                    {appliedMat ? (
                      appliedMat.type === 'texture' ? (
                        <div style={{
                          position: 'absolute',
                          top: '-50%', left: '-50%', width: '200%', height: '200%',
                          backgroundImage: `url(${appliedMat.image})`,
                          backgroundSize: '200px',
                          transform: seg.autoTransform,
                          transformOrigin: 'center center',
                          opacity: 0.85,
                        }} />
                      ) : (
                        <div style={{
                          position: 'absolute', inset: 0,
                          backgroundColor: appliedMat.color,
                          opacity: 0.9
                        }} />
                      )
                    ) : (
                      <div style={{
                        position: 'absolute', inset: 0,
                        backgroundColor: 'rgba(0, 120, 255, 0.4)'
                      }} />
                    )}
                  </div>
                );
              })}

              {loading && (
                <div className="loading-overlay">
                  <Loader2 className="spinner" size={48} />
                  <p>{progress}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="sidebar">
          {segments.length > 0 ? (
            <>
              <div className="status-panel success">
                ✔ 인공지능이 공간을 성공적으로 분리했습니다!<br />
                <span className="help-text">이미지에서 벽, 바닥, 천장을 클릭해보세요.</span>
              </div>

              {selectedSegmentId !== null ? (
                <div className="material-panel">
                  <h3>
                    <PaintBucket size={18} />
                    마감재 변경하기
                  </h3>
                  <div className="selected-info">
                    현재 선택됨: <b>{segments[selectedSegmentId].labelKey === 'wall' ? '벽 (Wall)' : segments[selectedSegmentId].labelKey === 'floor' ? '바닥 (Floor)' : '천장 (Ceiling)'}</b>
                  </div>

                  <div className="material-grid">
                    {MATERIALS[segments[selectedSegmentId].labelKey].map(mat => (
                      <div
                        key={mat.id}
                        className={`material-item ${appliedMaterials[selectedSegmentId]?.id === mat.id ? 'active' : ''}`}
                        onClick={() => applyMaterial(mat)}
                      >
                        <div className="material-color"
                          style={{
                            backgroundColor: mat.color || '#cccccc',
                            backgroundImage: mat.type === 'texture' ? `url(${mat.image})` : 'none',
                            backgroundSize: 'cover'
                          }}>
                        </div>
                        <span className="material-name">{mat.name}</span>
                      </div>
                    ))}
                  </div>

                  <button className="reset-btn" onClick={() => {
                    const next = { ...appliedMaterials };
                    delete next[selectedSegmentId];
                    setAppliedMaterials(next);
                  }}>초기화</button>
                </div>
              ) : (
                <div className="guidance-panel">
                  <ImageIcon size={32} />
                  <p>수정할 공간 <strong>(벽, 바닥, 천장)</strong>을 이미지에서 직접 클릭해주세요.</p>
                </div>
              )}
            </>
          ) : (
            <div className="empty-sidebar">
              <h3>진행 순서</h3>
              <ol className="step-list">
                <li>이미지 업로드</li>
                <li>AI가 공간 구조 인식 (벽, 바닥 등)</li>
                <li>원하는 영역 클릭 후 마스킹</li>
                <li>재질과 컬러 선택</li>
              </ol>
            </div>
          )}

          {image && !loading && (
            <button className="new-image-btn" onClick={() => {
              setImage(null);
              setSegments([]);
              setAppliedMaterials({});
              setSelectedSegmentId(null);
            }}>새로운 이미지 업로드</button>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
