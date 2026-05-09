import { useRef, useState, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useTexture, Html } from "@react-three/drei";
import * as THREE from "three";
import type { Frame } from "./types";

interface FramePlaneProps {
  frame: Frame;
  total: number;
  index: number;
  onSelect: (index: number) => void;
}

function FramePlane({ frame, total, index, onSelect }: FramePlaneProps) {
  const texture = useTexture(frame.url);
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const appearAt = useRef(performance.now() / 1000 + index * 0.08);
  const tmpScale = useRef(new THREE.Vector3(0.001, 0.001, 0.001));

  texture.colorSpace = THREE.SRGBColorSpace;

  const divisor = Math.max(1, total - 1);
  const angle = THREE.MathUtils.degToRad(-55 + (index / divisor) * 110);
  const radius = 4.2;
  const baseX = Math.sin(angle) * radius;
  const baseZ = -Math.cos(angle) * radius + radius;
  const baseY = Math.sin(index * 0.7) * 0.15;

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    meshRef.current.rotation.y = -angle + Math.sin(t * 0.4 + index) * 0.05;
    meshRef.current.position.x = baseX;
    meshRef.current.position.z = baseZ;
    meshRef.current.position.y = baseY + Math.sin(t * 0.6 + index) * 0.06;

    // intro drop-in
    const life = performance.now() / 1000 - appearAt.current;
    const intro = Math.min(1, Math.max(0, life / 0.9));
    const target = (hovered ? 1.12 : 1) * easeOutCubic(intro);
    tmpScale.current.set(target, target, target);
    meshRef.current.scale.lerp(tmpScale.current, 0.18);
  });

  return (
    <mesh
      ref={meshRef}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(frame.index);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = "auto";
      }}
    >
      <planeGeometry args={[1.9, 1.2]} />
      <meshStandardMaterial
        map={texture}
        side={THREE.DoubleSide}
        roughness={0.55}
        metalness={0.05}
      />
      {hovered && (
        <Html position={[0, -0.8, 0]} center distanceFactor={8}>
          <div
            className="font-serif text-xs uppercase tracking-[0.3em] px-2 py-1 whitespace-nowrap"
            style={{
              color: "var(--reel-bg)",
              background: "var(--reel-amber)",
            }}
          >
            {frame.year}
          </div>
        </Html>
      )}
    </mesh>
  );
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

interface Props {
  frames: Frame[];
  onSelect: (index: number) => void;
}

export function FinaleMontage({ frames, onSelect }: Props) {
  return (
    <div className="w-[min(95vw,1400px)] h-[70vh] flex flex-col items-center">
      <Canvas camera={{ position: [0, 0.4, 5.2], fov: 45 }} dpr={[1, 2]}>
        <color attach="background" args={["#0d0b08"]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 5, 5]} intensity={0.7} color="#f6c56a" />
        <spotLight
          position={[0, 4, 2]}
          intensity={1.2}
          angle={0.6}
          penumbra={0.9}
          color="#d4a24c"
        />
        <Suspense fallback={null}>
          {frames.map((f, i) => (
            <FramePlane
              key={f.index}
              frame={f}
              total={frames.length}
              index={i}
              onSelect={onSelect}
            />
          ))}
        </Suspense>
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          minPolarAngle={Math.PI / 3}
          maxPolarAngle={Math.PI / 2.15}
          autoRotate
          autoRotateSpeed={0.4}
        />
      </Canvas>
      <p
        className="mt-2 font-serif text-[0.7rem] uppercase tracking-[0.4em] opacity-60"
        style={{ color: "var(--reel-paper)" }}
      >
        The Archive · click a frame to revisit · drag to explore
      </p>
    </div>
  );
}
