const THREE = await import("./vendor/three.module.min.js");

const CASE_SPACING = 5.2;
const CASE_COUNT = 5;

function makeCanvasTexture(width, height, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  draw(context, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makeWoodTexture() {
  const texture = makeCanvasTexture(1024, 512, (context, width, height) => {
    context.fillStyle = "#6b4029";
    context.fillRect(0, 0, width, height);
    for (let x = 0; x < width; x += 92) {
      context.fillStyle = x % 184 === 0 ? "#5a3422" : "#7b4b2e";
      context.fillRect(x, 0, 86, height);
      context.fillStyle = "rgba(20,9,5,.34)";
      context.fillRect(x + 86, 0, 5, height);
      context.fillStyle = "rgba(255,225,175,.035)";
      context.fillRect(x + 4, 0, 1, height);
    }
    for (let index = 0; index < 90; index += 1) {
      const x = (index * 73) % width;
      const y = (index * 127) % height;
      context.strokeStyle = `rgba(30,13,7,${0.03 + (index % 4) * 0.012})`;
      context.beginPath();
      context.moveTo(x, y);
      context.bezierCurveTo(x + 28, y + 4, x + 40, y - 3, x + 74, y + 2);
      context.stroke();
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(12, 8);
  return texture;
}

function makePlaqueTexture(name) {
  return makeCanvasTexture(768, 128, (context, width, height) => {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#6d472e");
    gradient.addColorStop(1, "#321d14");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(244,214,143,.65)";
    context.lineWidth = 5;
    context.strokeRect(5, 5, width - 10, height - 10);
    context.fillStyle = "#fff0c9";
    context.font = "600 43px 'Microsoft YaHei', 'PingFang SC', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const labels = String(name || "空展柜");
    const clipped = labels.length > 16 ? `${labels.slice(0, 15)}…` : labels;
    context.fillText(clipped, width / 2, height / 2 + 2);
  });
}

function makePlusTexture() {
  return makeCanvasTexture(256, 256, (context, width, height) => {
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(232,212,170,.32)";
    context.lineWidth = 8;
    context.strokeRect(4, 4, width - 8, height - 8);
    context.fillStyle = "rgba(244,214,143,.48)";
    context.font = "300 112px 'Microsoft YaHei', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("+", width / 2, height / 2 + 3);
  });
}

function makeGlowTexture() {
  return makeCanvasTexture(256, 256, (context, width, height) => {
    const gradient = context.createRadialGradient(
      width / 2,
      height / 2,
      4,
      width / 2,
      height / 2,
      width / 2,
    );
    gradient.addColorStop(0, "rgba(255,232,172,.72)");
    gradient.addColorStop(0.35, "rgba(244,199,111,.2)");
    gradient.addColorStop(1, "rgba(244,199,111,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  });
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials.filter(Boolean)) {
      if (!material.userData?.sharedTexture) {
        for (const value of Object.values(material)) {
          if (value?.isTexture) value.dispose();
        }
      }
      material.dispose?.();
    }
  });
}

function loadTexture(loader, source) {
  return new Promise((resolve, reject) => {
    loader.load(
      source,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

export async function createMuseum3D({ canvas, onSelect }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x160d09, 0.032);

  const camera = new THREE.PerspectiveCamera(40, 2.8, 0.1, 70);
  camera.position.set(0.8, 2.85, 8.8);

  const caseRoot = new THREE.Group();
  scene.add(caseRoot);
  const loader = new THREE.TextureLoader();
  const glowTexture = makeGlowTexture();
  const plusTexture = makePlusTexture();
  const hitboxes = [];
  const caseObjects = [];
  const woodTexture = makeWoodTexture();
  let dataGeneration = 0;
  let activeSlot = 0;
  let overview = false;
  let inspecting = false;
  let disposed = false;
  let dragStart = null;
  let hasPositionedCamera = false;
  const cameraTarget = {
    x: 0.8,
    y: 2.9,
    z: 8.8,
    lookX: 0,
    lookY: 2.6,
  };
  const clock = new THREE.Clock();

  const ambient = new THREE.AmbientLight(0xb99168, 1.2);
  scene.add(ambient);
  const hemisphere = new THREE.HemisphereLight(0xffe1a8, 0x25150e, 1.55);
  scene.add(hemisphere);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(62, 36),
    new THREE.MeshStandardMaterial({
      map: woodTexture,
      color: 0x8a5a38,
      roughness: 0.82,
      metalness: 0.04,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -0.03, -4);
  scene.add(floor);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(62, 11),
    new THREE.MeshStandardMaterial({
      color: 0x342017,
      roughness: 0.9,
      metalness: 0.02,
    }),
  );
  wall.position.set(0, 4.9, -4.4);
  scene.add(wall);

  for (let index = -7; index <= 7; index += 1) {
    const pilaster = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 8.5, 0.36),
      new THREE.MeshStandardMaterial({
        color: index % 2 === 0 ? 0x4b2c1e : 0x3c2318,
        roughness: 0.86,
      }),
    );
    pilaster.position.set(index * 3.9, 4.1, -4.16);
    scene.add(pilaster);
  }

  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(62, 0.38, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x26150f, roughness: 0.75 }),
  );
  cornice.position.set(0, 8.35, -4.0);
  scene.add(cornice);

  function frameMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xa87539,
      roughness: 0.32,
      metalness: 0.72,
    });
  }

  function woodMaterial(color = 0x66402a) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.76,
      metalness: 0.06,
    });
  }

  function addFrameBox(group, width, height, depth, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), frameMaterial());
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }

  function buildPedestal(group) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.32, 2.25), woodMaterial(0x4a2b1d));
    base.position.y = 0.16;
    group.add(base);

    const upperBase = new THREE.Mesh(new THREE.BoxGeometry(2.75, 0.24, 1.9), woodMaterial(0x5b3825));
    upperBase.position.y = 0.42;
    group.add(upperBase);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.64, 0.8, 1.38, 24),
      woodMaterial(0x68412b),
    );
    shaft.position.y = 1.23;
    group.add(shaft);

    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2;
      const flute = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 1.3, 6),
        woodMaterial(index % 2 ? 0x7c4c30 : 0x533322),
      );
      flute.position.set(Math.cos(angle) * 0.69, 1.23, Math.sin(angle) * 0.69);
      group.add(flute);
    }

    const capital = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.27, 1.8), woodMaterial(0x775039));
    capital.position.y = 2.02;
    group.add(capital);
  }

  function buildGlassCase(group, relic) {
    const caseBottom = 2.18;
    const glassHeight = 2.9;
    const glassCenterY = caseBottom + glassHeight / 2;
    const glassWidth = 4.5;
    const glassDepth = 2.75;

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(4.75, 0.17, 3.0),
      woodMaterial(0x815535),
    );
    deck.position.y = caseBottom;
    group.add(deck);

    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xbce9df,
      transparent: true,
      opacity: 0.13,
      roughness: 0.04,
      metalness: 0,
      transmission: 0.28,
      thickness: 0.32,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(glassWidth, glassHeight, glassDepth),
      glassMaterial,
    );
    glass.position.set(0, glassCenterY, 0);
    glass.renderOrder = 3;
    group.add(glass);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(glassWidth, glassHeight, glassDepth)),
      new THREE.LineBasicMaterial({
        color: 0xe6c77e,
        transparent: true,
        opacity: 0.72,
      }),
    );
    edges.position.copy(glass.position);
    edges.renderOrder = 4;
    group.add(edges);

    const frontZ = glassDepth / 2 + 0.015;
    addFrameBox(group, glassWidth + 0.1, 0.08, 0.08, 0, caseBottom, frontZ);
    addFrameBox(group, glassWidth + 0.1, 0.08, 0.08, 0, caseBottom + glassHeight, frontZ);
    addFrameBox(group, 0.08, glassHeight, 0.08, -glassWidth / 2, glassCenterY, frontZ);
    addFrameBox(group, 0.08, glassHeight, 0.08, glassWidth / 2, glassCenterY, frontZ);

    const topPlate = new THREE.Mesh(
      new THREE.BoxGeometry(4.7, 0.13, 2.95),
      woodMaterial(0x54321f),
    );
    topPlate.position.y = caseBottom + glassHeight + 0.03;
    group.add(topPlate);

    const lampMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe2a1,
      transparent: true,
      opacity: 0.9,
    });
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.07, 28), lampMaterial);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(0, caseBottom + glassHeight - 0.18, 0.05);
    group.add(lamp);

    const lightCone = new THREE.Mesh(
      new THREE.ConeGeometry(1.5, 2.55, 32, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffdda0,
        transparent: true,
        opacity: 0.055,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    lightCone.position.set(0, caseBottom + 1.25, 0);
    lightCone.renderOrder = 1;
    group.add(lightCone);

    const pointLight = new THREE.PointLight(0xffd995, 12, 5.5, 2);
    pointLight.position.set(0, caseBottom + 2.55, 0.2);
    group.add(pointLight);

    const innerShelf = new THREE.Mesh(
      new THREE.CylinderGeometry(1.25, 1.35, 0.11, 36),
      new THREE.MeshStandardMaterial({
        color: 0x6d472d,
        roughness: 0.46,
        metalness: 0.2,
      }),
    );
    innerShelf.position.set(0, caseBottom + 0.16, 0);
    group.add(innerShelf);

    const shelfRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.31, 0.035, 8, 48),
      frameMaterial(),
    );
    shelfRing.rotation.x = Math.PI / 2;
    shelfRing.position.set(0, caseBottom + 0.23, 0);
    group.add(shelfRing);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xffe3a8,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.material.userData.sharedTexture = true;
    glow.scale.set(2.4, 2.4, 1);
    glow.position.set(0, caseBottom + 1.47, -0.35);
    glow.renderOrder = 2;
    group.add(glow);

    const pivot = new THREE.Group();
    pivot.position.set(0, caseBottom + 0.62, 0);
    group.add(pivot);

    if (relic?.image) {
      const image = new Image();
      image.onload = () => {
        const maximumWidth = 2.32;
        const maximumHeight = 1.68;
        const scale = Math.min(
          maximumWidth / image.naturalWidth,
          maximumHeight / image.naturalHeight,
        );
        loadTexture(loader, relic.image)
          .then((texture) => {
            if (disposed) return;
            const material = new THREE.MeshBasicMaterial({
              map: texture,
              transparent: true,
              alphaTest: 0.02,
              side: THREE.DoubleSide,
              depthWrite: false,
            });
            const item = new THREE.Mesh(
              new THREE.PlaneGeometry(
                image.naturalWidth * scale,
                image.naturalHeight * scale,
              ),
              material,
            );
            item.renderOrder = 5;
            pivot.add(item);
          })
          .catch((error) => console.warn("3D relic image skipped.", error));
      };
      image.src = relic.image;
    } else {
      const empty = new THREE.Mesh(
        new THREE.PlaneGeometry(1.05, 1.05),
        new THREE.MeshBasicMaterial({
          map: plusTexture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      empty.material.userData.sharedTexture = true;
      empty.position.y = 0.25;
      group.add(empty);
    }

    const plaqueTexture = makePlaqueTexture(relic?.name || "空展柜");
    const plaque = new THREE.Mesh(
      new THREE.PlaneGeometry(3.25, 0.42),
      new THREE.MeshBasicMaterial({
        map: plaqueTexture,
        transparent: true,
      }),
    );
    plaque.position.set(0, 1.82, 1.57);
    group.add(plaque);

    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(5.1, 5.5, 3.5),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    hitbox.position.set(0, 2.75, 0);
    hitbox.userData.slot = group.userData.slot;
    hitboxes.push(hitbox);
    group.add(hitbox);

    return { group, pivot, pointLight };
  }

  async function setData(relics, nextActiveSlot, options = {}) {
    dataGeneration += 1;
    const generation = dataGeneration;
    activeSlot = nextActiveSlot;
    overview = Boolean(options.overview);
    inspecting = Boolean(options.inspecting);
    hitboxes.length = 0;
    for (const item of caseObjects) disposeObject(item.group);
    caseObjects.length = 0;
    caseRoot.clear();

    for (let index = 0; index < CASE_COUNT; index += 1) {
      if (generation !== dataGeneration) return;
      const group = new THREE.Group();
      group.position.x = (index - 2) * CASE_SPACING;
      group.userData.slot = index;
      buildPedestal(group);
      const caseParts = buildGlassCase(group, relics[index]);
      caseParts.group.position.x = group.position.x;
      caseRoot.add(group);
      caseObjects.push(caseParts);
    }
    updateCameraTarget();
  }

  function updateCameraTarget() {
    const caseX = (activeSlot - 2) * CASE_SPACING;
    for (const [index, item] of caseObjects.entries()) {
      item.group.visible = overview || index === activeSlot;
    }
    if (overview) {
      cameraTarget.x = 0;
      cameraTarget.y = 3.65;
      cameraTarget.z = 16.2;
      cameraTarget.lookX = 0;
      cameraTarget.lookY = 2.45;
      return;
    }
    if (inspecting) {
      cameraTarget.x = caseX + 1.3;
      cameraTarget.y = 2.9;
      cameraTarget.z = 8.8;
      cameraTarget.lookX = caseX + 2.15;
      cameraTarget.lookY = 2.62;
      return;
    }
    cameraTarget.x = caseX + 0.9;
    cameraTarget.y = 2.85;
    cameraTarget.z = 8.8;
    cameraTarget.lookX = caseX;
    cameraTarget.lookY = 2.6;
    if (!hasPositionedCamera && !overview) {
      camera.position.set(cameraTarget.x, cameraTarget.y, cameraTarget.z);
      const initialLook = new THREE.Vector3(cameraTarget.lookX, cameraTarget.lookY, -0.15);
      camera.userData.look = initialLook;
      camera.lookAt(initialLook);
      hasPositionedCamera = true;
    }
  }

  function updateView({ activeSlot: nextActive, overview: nextOverview, inspecting: nextInspecting }) {
    activeSlot = nextActive;
    overview = nextOverview;
    inspecting = nextInspecting;
    updateCameraTarget();
  }

  function resize() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function pointerCoordinates(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  canvas.addEventListener("pointerdown", (event) => {
    dragStart = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
    dragStart = null;
    if (moved > 14) return;
    pointerCoordinates(event);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hitboxes, false)[0];
    if (hit) onSelect?.(hit.object.userData.slot);
  });
  canvas.addEventListener("pointermove", (event) => {
    pointerCoordinates(event);
    raycaster.setFromCamera(pointer, camera);
    canvas.style.cursor = raycaster.intersectObjects(hitboxes, false).length ? "pointer" : "default";
  });

  let frameId = 0;
  function render() {
    if (disposed) return;
    frameId = requestAnimationFrame(render);
    const delta = Math.min(clock.getDelta(), 0.04);
    const ease = 1 - Math.pow(0.001, delta);
    camera.position.x += (cameraTarget.x - camera.position.x) * ease;
    camera.position.y += (cameraTarget.y - camera.position.y) * ease;
    camera.position.z += (cameraTarget.z - camera.position.z) * ease;
    const currentLook = camera.userData.look || new THREE.Vector3(0, cameraTarget.lookY, 0);
    currentLook.x += (cameraTarget.lookX - currentLook.x) * ease;
    currentLook.y += (cameraTarget.lookY - currentLook.y) * ease;
    currentLook.z += (-0.15 - currentLook.z) * ease;
    camera.userData.look = currentLook;
    camera.lookAt(currentLook);

    for (let index = 0; index < caseObjects.length; index += 1) {
      const item = caseObjects[index];
      item.pivot.rotation.y += delta * (index === activeSlot ? 0.52 : 0.22);
      item.pivot.position.y += Math.sin(performance.now() * 0.0012 + index) * 0.00035;
      const targetIntensity = overview ? 7 : index === activeSlot ? 15 : 4;
      item.pointLight.intensity += (targetIntensity - item.pointLight.intensity) * ease;
    }
    renderer.render(scene, camera);
  }
  render();

  return {
    setData,
    updateView,
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      for (const item of caseObjects) disposeObject(item.group);
      woodTexture.dispose();
      glowTexture.dispose();
      plusTexture.dispose();
      renderer.dispose();
    },
  };
}
