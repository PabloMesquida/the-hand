import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Inspector } from 'three/addons/inspector/Inspector.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { Fn, color, mix, positionLocal, positionWorld, rand, screenCoordinate, screenUV, texture, uniform, vec2, vec3 } from 'three/tsl'
import FrostedGlass from './FrostedGlass.js'
import Membrane from './Membrane.js'
import Hand from './Hand.js'
import MouseDebug from './MouseDebug.js'

/**
 * Base
 */
// Debug: por defecto los paneles visuales + "Hand" simplificado (los parámetros que dibuja Mouse debug) y la cámara fija;
// con #debug en la URL, "Hand" completo y la cámara orbitable
const debug = window.location.hash === '#debug'
window.addEventListener('hashchange', () => window.location.reload())

// Canvas
const canvas = document.querySelector('canvas.threejs')

// Scenes
const scene = new THREE.Scene() // Vidrio (lo que ve la cámara)
const handScene = new THREE.Scene() // Todo lo que está detrás del vidrio

// Loaders
const gltfLoader = new GLTFLoader()

/**
 * Sizes
 */
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
}

window.addEventListener('resize', () =>
{
    // Update sizes
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight

    // Update camera
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()

    // Update renderer
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})

/**
 * Cursor
 */
const raycaster = new THREE.Raycaster()
const cursor = new THREE.Vector2()
const intersectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)

window.addEventListener('pointermove', (event) =>
{
    cursor.x = (event.clientX / sizes.width) * 2 - 1
    cursor.y = - (event.clientY / sizes.height) * 2 + 1
})

/**
 * Camera
 */
// Base camera
const camera = new THREE.PerspectiveCamera(35, sizes.width / sizes.height, 0.1, 100)
camera.position.z = 8
scene.add(camera)

// Controls (solo en #debug)
const controls = new OrbitControls(camera, canvas)
controls.enabled = debug
controls.enableDamping = true
controls.enablePan = false
controls.minAzimuthAngle = - 0.5
controls.maxAzimuthAngle = 0.5
controls.minPolarAngle = Math.PI * 0.5 - 0.4
controls.maxPolarAngle = Math.PI * 0.5 + 0.4
controls.minDistance = 4
controls.maxDistance = 14

/**
 * Renderer
 */
const renderer = new THREE.WebGPURenderer({
    canvas: canvas,
    antialias: true
})
renderer.toneMapping = THREE.NoToneMapping
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(0x000000)
renderer.inspector = new Inspector()
await renderer.init()

/**
 * Frosted glass
 */
const frostedGlass = new FrostedGlass(renderer)

// Debug
const frostedGui = renderer.inspector.createParameters('Frosted glass')
frostedGui.add(frostedGlass.maxDistance, 'value', 0.5, 8, 0.01).name('maxDistance')
frostedGui.add(frostedGlass.maxLevel, 'value', 0, frostedGlass.levels, 0.01).name('maxBlur')
frostedGui.add(frostedGlass.curve, 'value', 0.2, 3, 0.01).name('curve')
frostedGui.add(frostedGlass.scatter, 'value', 0, 4, 0.01).name('scatter')
frostedGui.add(frostedGlass.farOpacity, 'value', 0, 1, 0.001).name('farOpacity')

/**
 * Membrane
 */
const membrane = new Membrane(renderer)

// Debug
const membraneGui = renderer.inspector.createParameters('Membrane')
membraneGui.add(membrane, 'enabled').name('enabled').onChange((value) => membrane.setEnabled(value))
membraneGui.add(membrane.slope, 'value', 0.2, 4, 0.001).name('slope')
membraneGui.add(membrane.profile, 'value', 1, 5, 0.001).name('profile')
membraneGui.add(membrane.stiffness, 'value', 10, 400, 0.1).name('stiffness')
membraneGui.add(membrane.damping, 'value', 0, 30, 0.01).name('damping')

/**
 * Glass
 */
const glassColorCenter = uniform(color('#eaf2fc'))
const glassColorEdge = uniform(color('#8cb0e3'))
const silhouetteColor = uniform(color('#1d3a78'))
const silhouetteMix = uniform(0.541)
const grainStrength = uniform(0.008)

const lightDirection = uniform(new THREE.Vector3(- 0.5, 0.7, 1))
const shadingStrength = uniform(0)
const specularStrength = uniform(0)
const shininess = uniform(1)
const stretchStrength = uniform(0)
const creaseStrength = uniform(0)
const fabricCover = uniform(0.189)

const glassMaterial = new THREE.MeshBasicNodeMaterial()

// Deformación
glassMaterial.positionNode = Fn(() =>
{
    const newPosition = positionLocal.toVar()
    newPosition.z.addAssign(membrane.heightAt(positionLocal.xy))

    return newPosition
})()

glassMaterial.colorNode = Fn(() =>
{
    // Lo que hay detrás del vidrio, ya borroneado
    const frost = texture(frostedGlass.texture, screenUV)

    // Vidrio iluminado desde atrás (más claro al centro)
    const glassMix = screenUV.sub(0.5).length().mul(1.5).smoothstep(0, 1)
    const glass = mix(glassColorCenter, glassColorEdge, glassMix)

    // Altura de la tela
    const spacing = membrane.texelSize
    const position = positionWorld.xy
    const height = membrane.heightAt(position)

    // Silueta (donde la tela está empujada, la cubre)
    const cover = height.smoothstep(0, 0.2).mul(fabricCover).oneMinus()
    const hand = mix(frost.rgb, silhouetteColor, silhouetteMix)
    const finalColor = mix(glass, hand, frost.a.mul(cover)).toVar()

    // Normal de la tela (diferencias finitas sobre la altura)
    const heightLeft = membrane.heightAt(position.sub(vec2(spacing, 0)))
    const heightRight = membrane.heightAt(position.add(vec2(spacing, 0)))
    const heightDown = membrane.heightAt(position.sub(vec2(0, spacing)))
    const heightUp = membrane.heightAt(position.add(vec2(0, spacing)))
    const normal = vec3(heightLeft.sub(heightRight), heightDown.sub(heightUp), spacing * 2).normalize()

    // Luz (relativa al plano sin deformar: el vidrio plano no cambia)
    const flatNormal = vec3(0, 0, 1)
    const light = lightDirection.normalize()
    const diffuse = normal.dot(light).sub(flatNormal.dot(light))

    const halfVector = light.add(vec3(0, 0, 1)).normalize()
    const specular = normal.dot(halfVector).max(0).pow(shininess).sub(flatNormal.dot(halfVector).pow(shininess))

    // La tela estirada se afina (más clara), los pliegues entre dedos se oscurecen
    const stretch = normal.z.oneMinus()
    const curvature = heightLeft.add(heightRight).add(heightDown).add(heightUp).sub(height.mul(4)).div(spacing * spacing)

    finalColor.mulAssign(diffuse.mul(shadingStrength).add(1))
    finalColor.addAssign(specular.mul(specularStrength))
    finalColor.addAssign(stretch.mul(stretchStrength))
    finalColor.subAssign(curvature.max(0).mul(creaseStrength))

    // Grano
    finalColor.addAssign(rand(screenCoordinate.xy).sub(0.5).mul(grainStrength))

    return finalColor
})()

// Tela deformable (zona del bastidor)
const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(membrane.size, membrane.size, membrane.resolution, membrane.resolution),
    glassMaterial
)
glass.position.z = frostedGlass.glassZ.value
scene.add(glass)

// Vidrio de fondo (fuera del bastidor, plano)
const glassBackground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    glassMaterial
)
glassBackground.position.z = frostedGlass.glassZ.value - 0.01
scene.add(glassBackground)

// Visibilidad (sin vidrio se ve la mano directo, para definir la pose y la animación)
const glassOptions = {
    visible: true
}

const handBackground = new THREE.Color('#5a6270')

const updateGlassVisibility = () =>
{
    handScene.background = glassOptions.visible ? null : handBackground

    // Sin vidrio la cámara orbita libre alrededor de la mano
    controls.target.set(0, 0, glassOptions.visible ? 0 : - 1)
    controls.minAzimuthAngle = glassOptions.visible ? - 0.5 : - Infinity
    controls.maxAzimuthAngle = glassOptions.visible ? 0.5 : Infinity
    controls.minPolarAngle = glassOptions.visible ? Math.PI * 0.5 - 0.4 : 0
    controls.maxPolarAngle = glassOptions.visible ? Math.PI * 0.5 + 0.4 : Math.PI
    controls.minDistance = glassOptions.visible ? 4 : 1.5
}
updateGlassVisibility()

// Debug
const glassGui = renderer.inspector.createParameters('Glass')
glassGui.add(glassOptions, 'visible').name('visible').onChange(updateGlassVisibility)
glassGui.addColor(glassColorCenter, 'value').name('colorCenter')
glassGui.addColor(glassColorEdge, 'value').name('colorEdge')
glassGui.addColor(silhouetteColor, 'value').name('silhouetteColor')
glassGui.add(silhouetteMix, 'value', 0, 1, 0.001).name('silhouetteMix')
glassGui.add(grainStrength, 'value', 0, 0.2, 0.001).name('grain')

const fabricGui = renderer.inspector.createParameters('Fabric shading')
fabricGui.add(lightDirection.value, 'x', - 1, 1, 0.001).name('lightX')
fabricGui.add(lightDirection.value, 'y', - 1, 1, 0.001).name('lightY')
fabricGui.add(shadingStrength, 'value', 0, 3, 0.001).name('shading')
fabricGui.add(specularStrength, 'value', 0, 2, 0.001).name('specular')
fabricGui.add(shininess, 'value', 1, 128, 0.1).name('shininess')
fabricGui.add(stretchStrength, 'value', 0, 2, 0.001).name('stretch')
fabricGui.add(creaseStrength, 'value', 0, 0.1, 0.0001).name('crease')
fabricGui.add(fabricCover, 'value', 0, 1, 0.001).name('cover')

/**
 * Hand
 */
const handOptions = {
    distance: 1, // Fija (negativo = atraviesa el vidrio y empuja la tela)
    rotationX: 0.5,
    rotationY: 0,
    rotationZ: 0,
    reachNear: 0.123, // Distancia en pantalla (alto de pantalla = 2) a la que el índice queda del todo estirado
    reachFar: 0.557, // Distancia a partir de la cual no se estira
    aimNear: 0.984, // Distancia en pantalla mouse <-> muñeca a la que la mano gira del todo hacia el mouse
    aimFar: 1.5 // Distancia a partir de la cual la mano no gira
}

const indexTip = new THREE.Vector3()
const wristPosition = new THREE.Vector3()

const gltf = await gltfLoader.loadAsync('./hand.glb')
const hand = new Hand(gltf)
handScene.add(hand.group)

// Debug (simplificado: distance y los rangos que dibuja Mouse debug; el resto con #debug)
const handGui = renderer.inspector.createParameters('Hand')
handGui.add(handOptions, 'distance', - 1.5, 6, 0.001).name('distance')
if(debug)
{
    handGui.add(handOptions, 'rotationX', - Math.PI, Math.PI, 0.001).name('rotationX')
    handGui.add(handOptions, 'rotationY', - Math.PI, Math.PI, 0.001).name('rotationY')
    handGui.add(handOptions, 'rotationZ', - Math.PI, Math.PI, 0.001).name('rotationZ')
    handGui.add(hand, 'pointing', 0, 1, 0.001).name('pointing')
    handGui.add(hand, 'aim', 0, 1, 0.001).name('aim')
    handGui.add(hand, 'wiggle', 0, 4, 0.001).name('wiggle')
    handGui.add(hand, 'spread', - 1, 2, 0.001).name('spread')
    handGui.add(hand, 'reach', 0, 1, 0.001).name('reach').listen()
    handGui.add(hand, 'reachStrength', 0, 3, 0.001).name('reachStrength')
}
handGui.add(handOptions, 'reachNear', 0, 1, 0.001).name('reachNear')
handGui.add(handOptions, 'reachFar', 0, 2, 0.001).name('reachFar')
handGui.add(handOptions, 'aimNear', 0, 2, 0.001).name('aimNear')
handGui.add(handOptions, 'aimFar', 0, 3, 0.001).name('aimFar')
if(debug)
{
    handGui.add(hand, 'proximity', 0, 1, 0.001).name('proximity').listen()
    handGui.add(hand, 'aimDepth', - 2, 6, 0.001).name('aimDepth')
    handGui.add(hand.aimJoints.forearm, 'twist', 0, 1, 0.001).name('aimTwist')
    handGui.add(hand.aimJoints.forearm, 'maxTwist', 0, 90, 0.1).name('aimMaxTwist')
    handGui.add(hand.aimJoints.wrist, 'weight', 0, 1, 0.001).name('aimWrist')
    handGui.add(hand.aimJoints.index, 'weight', 0, 1, 0.001).name('aimIndex')
    handGui.add(hand, 'aimSmoothing', 1, 30, 0.1).name('aimSmoothing')
}

/**
 * Mouse debug
 */
const mouseDebug = new MouseDebug(handScene)

// Debug
const mouseDebugGui = renderer.inspector.createParameters('Mouse debug')
mouseDebugGui.add(mouseDebug, 'visible').name('visible')

/**
 * Lights
 */
const directionalLight = new THREE.DirectionalLight('#ffffff', 2.5)
directionalLight.position.set(1, 2, 4)
handScene.add(directionalLight)

const ambientLight = new THREE.AmbientLight('#859dff', 0.6)
handScene.add(ambientLight)

// Debug
const lightsGui = renderer.inspector.createParameters('Lights').close()
lightsGui.add(directionalLight, 'intensity', 0, 10, 0.01).name('directionalIntensity')
lightsGui.add(ambientLight, 'intensity', 0, 5, 0.01).name('ambientIntensity')

/**
 * Animate
 */
const timer = new THREE.Timer()

const tick = () =>
{
    timer.update()
    const elapsedTime = timer.getElapsed()
    const deltaTime = timer.getDelta()

    // Update controls
    controls.update()
    camera.updateMatrixWorld()

    // Hand (fija a una distancia del vidrio)
    hand.group.position.z = frostedGlass.glassZ.value - handOptions.distance
    hand.group.rotation.set(handOptions.rotationX, handOptions.rotationY, handOptions.rotationZ)

    // El índice apunta al mouse: el punto bajo el cursor está a la misma profundidad que la punta del índice
    // (el mouse "está" en la línea del dedo, no delante; aimDepth lo adelanta hacia la cámara)
    hand.getIndexTip(indexTip)
    intersectionPlane.constant = - (indexTip.z + hand.aimDepth)
    raycaster.setFromCamera(cursor, camera)
    raycaster.ray.intersectPlane(intersectionPlane, hand.target)

    // Cuanto más cerca está el mouse de la punta del índice (en pantalla), más se estiran los dedos
    indexTip.project(camera)
    const aspect = sizes.width / sizes.height
    const tipDistance = Math.hypot((indexTip.x - cursor.x) * aspect, indexTip.y - cursor.y)
    hand.reachTarget = 1 - THREE.MathUtils.smoothstep(tipDistance, handOptions.reachNear, handOptions.reachFar)

    // La mano solo gira hacia el mouse cuando el mouse está cerca (se mide desde la muñeca, que casi no se mueve al girar)
    hand.wrist.getWorldPosition(wristPosition).project(camera)
    const wristDistance = Math.hypot((wristPosition.x - cursor.x) * aspect, wristPosition.y - cursor.y)
    hand.proximityTarget = 1 - THREE.MathUtils.smoothstep(wristDistance, handOptions.aimNear, handOptions.aimFar)

    hand.update(elapsedTime, deltaTime)

    // Mouse debug (la esfera 3D solo sin vidrio: con vidrio empujaría la tela)
    mouseDebug.update({
        cursor,
        wrist: wristPosition,
        tip: indexTip,
        target: hand.smoothedTarget,
        options: handOptions,
        wristDistance,
        tipDistance,
        proximity: hand.proximity,
        reach: hand.reach,
        sizes,
        show3D: !glassOptions.visible
    })

    if(glassOptions.visible)
    {
        // Render what's behind the glass + frosted blur
        frostedGlass.render(handScene, camera)

        // Membrane (depth from the camera side + compute; apagada no se calcula y el vidrio queda plano)
        if(membrane.enabled)
            membrane.update(handScene)

        // Render
        renderer.render(scene, camera)
    }
    else
    {
        // Solo la mano
        renderer.render(handScene, camera)
    }
}

renderer.setAnimationLoop(tick)
