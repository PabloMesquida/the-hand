import * as THREE from 'three/webgpu'

/**
 * Hand
 *
 * Mano con rig (static/hand.glb, hecha desde recursos/models/mano_03_sub_2_rig.blend con recursos/rig/build_rig.py)
 * Malla: mano + antebrazo del cuerpo masculino realista de Human Base Meshes (CC0), simplificada a ~15k vértices, sin textura (el material de piel se crea acá)
 * Huesos: forearm > hand > { thumb, index, middle, ring, pinky }_01..03
 * En cada hueso, rotar +X cierra el dedo hacia la palma y rotar +Z lo abre hacia el pulgar
 * La palma mira a +Z (hacia el vidrio)
 *
 * Poses (en grados, relativas a la pose del modelo):
 * - dedos => [ nudillo, falange media, falange distal, apertura ]
 * - wrist => [ flexión (+ hacia la palma, - hacia atrás), desviación (+ hacia el pulgar) ]
 * Se diseñan y revisan en Blender con recursos/rig/pose_preview.py (mismo formato)
 *
 * Reglas de una mano natural (referencias: posemaniacs, fotos):
 * - Cascada: el índice se dobla menos y el meñique más
 * - Mano relajada: la falange distal casi no se dobla (~0-25°, ~1/4-1/3 de la media). La relación ~2/3 es de un
 *   agarre activo, y aun ahí el meñique es el más bajo (~0.57)
 * - La pose de reposo tiene los dedos abiertos: anular y meñique se acercan (+ apertura), el índice se cierra (-)
 * - Anular y meñique están ligados (comparten tendones): el meñique sigue al anular, apenas más doblado
 */
const poses = {
    // Relajada con la muñeca flexionada (la mano "cae" hacia el vidrio), índice casi recto, el resto en cascada
    // (más de ~70° de flexión de muñeca pellizca la palma)
    relaxed: {
        wrist:  [ 65, 0 ],
        thumb:  [ 10, 20, 10, - 10 ],
        index:  [ 20, 28, 8, - 4 ],
        middle: [ 30, 45, 12, 0 ],
        ring:   [ 40, 55, 15, 4 ],
        pinky:  [ 48, 62, 18, 8 ]
    },
    // Relajada "elegante" anterior: muñeca hacia atrás
    // relaxedBack: { wrist: [ - 26, - 4 ], thumb: [ 6, 16, 14, - 8 ], index: [ 6, 14, 8, - 6 ], middle: [ 16, 36, 20, 0 ], ring: [ 24, 50, 26, 5 ], pinky: [ 32, 56, 28, 10 ] },
    // Señalar "suelto": los otros dedos curvados, no apretados
    point: {
        wrist:  [ 0, 0 ],
        thumb:  [ 12, 22, 18, - 18 ],
        index:  [ - 4, 3, 2, - 2 ],
        middle: [ 55, 72, 26, 0 ],
        ring:   [ 62, 78, 28, 4 ],
        pinky:  [ 70, 84, 32, 8 ]
    }
}

// Idle: fase de cada dedo y cuánto del movimiento del anular copia el meñique (dedos ligados)
const idlePhases = { thumb: 0, index: 1.3, middle: 2.6, ring: 3.9, pinky: 4.5 }
const pinkyRingLink = 0.7

// Cuánto wiggle recibe cada dedo (el meñique menos)
const wiggleAmounts = { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 0.4 }

const fingerNames = [ 'thumb', 'index', 'middle', 'ring', 'pinky' ]

// Apertura en abanico (grados por unidad de "spread"): + hacia el pulgar, - hacia el meñique
const spreadAmounts = { thumb: 10, index: 10, middle: 0, ring: - 8, pinky: - 16 }

// Estirarse hacia el mouse: pose estirada y cuánto la sigue cada dedo (en cascada desde el índice)
const reachPose = { thumb: [ 6, 10, 4 ], index: [ - 10, - 3, - 8 ], middle: [ 4, 6, 2 ], ring: [ 8, 10, 3 ], pinky: [ 10, 12, 4 ] }
const reachAmounts = { thumb: 0.2, index: 1, middle: 0.6, ring: 0.4, pinky: 0.3 }
export default class Hand
{
    constructor(gltf, height = 1.9)
    {
        this.model = gltf.scene
        this.group = new THREE.Group()
        this.group.add(this.model)

        // Pose
        this.pointing = 0.246 // 0 = relajada, 1 = señalando
        this.wiggle = 0.967 // Movimiento suave de los dedos (idle)
        this.spread = 0 // > 0 abre los dedos en abanico, < 0 los junta

        // Estirarse: "reachTarget" lo calcula script.js (0 = mouse lejos de la punta del índice, 1 = encima)
        this.reachTarget = 0
        this.reach = 0 // Suavizado
        this.reachStrength = 1.746 // Multiplica cuánto se estiran los dedos (> 1: llegan al máximo antes)
        // Apuntar
        this.target = new THREE.Vector3(0, 0, 0) // Hacia dónde apunta el índice (mundo)
        this.aim = 0.828 // 0 = no apunta, 1 = apunta
        this.proximityTarget = 0 // 0 = mouse lejos de la mano, 1 = cerca (lo calcula script.js)
        this.proximity = 0 // Suavizado
        this.aimAmount = 0 // aim x proximity (lo que se usa al girar)
        this.aimSmoothing = 6 // Velocidad con la que el brazo, la muñeca y el índice llegan a la rotación de apuntar (más alto = más rápido)
        this.aimDepth = 0 // El target está a la profundidad de la punta del índice + esta distancia hacia la cámara
        this.smoothedTarget = this.target.clone()

        // Cuánto aporta cada hueso al apuntar y sus límites anatómicos por eje (grados, relativos a la pose)
        // x = flexión (+ hacia la palma), y = torsión, z = desviación (+ hacia el pulgar)
        // El antebrazo gira sobre su eje (pronación / supinación) => la mano rota hacia los costados
        this.aimJoints = {
            forearm: { twist: 0.9, maxTwist: 70, weight: 0.3, min: [ - 10, - 70, - 4 ], max: [ 10, 70, 4 ] },
            wrist: { weight: 0.738, min: [ - 60, - 8, - 20 ], max: [ 10, 8, 20 ] },
            index: { weight: 0.82, min: [ - 20, 0, - 12 ], max: [ 30, 0, 12 ] }
        }

        this.setModel(height)
        this.setMaterial()
        this.setBones()
    }

    setMaterial()
    {
        // El modelo no trae textura: piel lisa
        this.material = new THREE.MeshPhysicalNodeMaterial({
            color: '#d9a68c',
            roughness: 0.55,
            sheen: 0.4,
            sheenColor: new THREE.Color('#ffd2c0'),
            sheenRoughness: 0.6
        })

        this.model.traverse((child) =>
        {
            if(child.isMesh)
                child.material = this.material
        })
    }

    setModel(height)
    {
        // Escala: de la muñeca a la punta del dedo medio mide "height"
        // Origen: centro de la mano (el antebrazo queda colgando hacia abajo)
        this.model.updateMatrixWorld(true)
        const wrist = this.model.getObjectByName('hand').getWorldPosition(new THREE.Vector3())
        const box = new THREE.Box3().setFromObject(this.model)
        const scale = height / (box.max.y - wrist.y)
        const center = new THREE.Vector3(wrist.x, (wrist.y + box.max.y) * 0.5, wrist.z)

        this.model.scale.setScalar(scale)
        this.model.position.copy(center).multiplyScalar(- scale)
    }

    setBones()
    {
        const getBone = (name) =>
        {
            const bone = this.model.getObjectByName(name)
            bone.userData.restQuaternion = bone.quaternion.clone()
            bone.userData.poseQuaternion = bone.quaternion.clone()
            return bone
        }

        this.forearm = getBone('forearm')
        this.wrist = getBone('hand')
        this.fingers = fingerNames.map((name) => ({
            name,
            phase: idlePhases[name],
            bones: [ 1, 2, 3 ].map(i => getBone(`${name}_0${i}`))
        }))
        this.indexFinger = this.fingers[1]

        // Temporales
        this.euler = new THREE.Euler()
        this.quaternion = new THREE.Quaternion()
        this.aimVectors = { pivot: new THREE.Vector3(), tip: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3() }
        this.aimQuaternions = { delta: new THREE.Quaternion(), world: new THREE.Quaternion(), parent: new THREE.Quaternion(), offset: new THREE.Quaternion() }
    }

    // Rotación relativa a la pose de reposo del rig (grados)
    setBoneRotation(bone, x, z)
    {
        this.euler.set(THREE.MathUtils.degToRad(x), 0, THREE.MathUtils.degToRad(z))
        this.quaternion.setFromEuler(this.euler)
        bone.quaternion.copy(bone.userData.restQuaternion).multiply(this.quaternion)
        bone.userData.poseQuaternion.copy(bone.quaternion)
    }

    setPose(elapsedTime)
    {
        const lerp = (a, b) => THREE.MathUtils.lerp(a, b, this.pointing)

        this.setBoneRotation(this.forearm, 0, 0)
        this.setBoneRotation(
            this.wrist,
            lerp(poses.relaxed.wrist[0], poses.point.wrist[0]),
            lerp(poses.relaxed.wrist[1], poses.point.wrist[1])
        )

        for(const finger of this.fingers)
        {
            const relaxed = poses.relaxed[finger.name]
            const point = poses.point[finger.name]

            // Idle (el meñique se mueve menos y copia en gran parte al anular;
            // el índice deja de moverse a medida que reach se acerca a 0.5, así no tiembla al apuntar)
            const indexCalm = finger === this.indexFinger ? 1 - THREE.MathUtils.smoothstep(this.reach, 0.25, 0.5) : 1
            const wiggleAmount = this.wiggle * wiggleAmounts[finger.name] * indexCalm
            const wave = (phase) => Math.sin(elapsedTime * 0.9 + phase)
            const motion = finger.name === 'pinky'
                ? THREE.MathUtils.lerp(wave(finger.phase), wave(idlePhases.ring), pinkyRingLink)
                : wave(finger.phase)
            const idle = motion * 4 * wiggleAmount

            // Estirarse hacia el mouse (el índice del todo, el resto en cascada)
            const reach = THREE.MathUtils.clamp(this.reach * this.reachStrength * reachAmounts[finger.name], 0, 1)

            finger.bones.forEach((bone, i) =>
            {
                const posed = lerp(relaxed[i], point[i]) + idle * (i === 0 ? 1 : 0.6)
                const flex = THREE.MathUtils.lerp(posed, reachPose[finger.name][i], reach)
                const spread = i === 0 ? lerp(relaxed[3], point[3]) + this.spread * spreadAmounts[finger.name] : 0
                this.setBoneRotation(bone, flex, spread)
            })
        }
    }

    // Rota "bone" para que la punta del índice quede en la línea pivot -> target,
    // limitando cada eje (respecto de la pose) a un rango anatómico
    aimBone(bone, { weight, min, max })
    {
        const { pivot, tip, from, to } = this.aimVectors
        const { delta, world, parent, offset } = this.aimQuaternions

        this.model.updateMatrixWorld(true)
        bone.getWorldPosition(pivot)
        this.indexFinger.bones[2].getWorldPosition(tip)

        from.subVectors(tip, pivot).normalize()
        to.subVectors(this.smoothedTarget, pivot).normalize()
        delta.setFromUnitVectors(from, to)
        delta.slerp(world.identity(), 1 - weight * this.aimAmount)

        // Delta en mundo => rotación local del hueso
        bone.getWorldQuaternion(world)
        world.premultiply(delta)
        bone.parent.getWorldQuaternion(parent)
        bone.quaternion.copy(parent.invert().multiply(world))

        // Límites por eje (sin esto la muñeca se tuerce y la malla se deforma)
        offset.copy(bone.userData.poseQuaternion).invert().multiply(bone.quaternion)
        this.euler.setFromQuaternion(offset, 'XYZ')
        this.euler.set(
            THREE.MathUtils.clamp(this.euler.x, THREE.MathUtils.degToRad(min[0]), THREE.MathUtils.degToRad(max[0])),
            THREE.MathUtils.clamp(this.euler.y, THREE.MathUtils.degToRad(min[1]), THREE.MathUtils.degToRad(max[1])),
            THREE.MathUtils.clamp(this.euler.z, THREE.MathUtils.degToRad(min[2]), THREE.MathUtils.degToRad(max[2]))
        )
        offset.setFromEuler(this.euler)
        bone.quaternion.copy(bone.userData.poseQuaternion).multiply(offset)
    }

    // Gira "bone" sobre su propio eje (torsión) para que la punta del índice quede del lado del target
    // (aimBone no sirve para esto: desde el codo la rotación mínima inclina el brazo en vez de girarlo)
    aimTwist(bone, { twist, maxTwist })
    {
        const { pivot, tip, from, to } = this.aimVectors
        const { delta, world, parent } = this.aimQuaternions
        const axis = this.aimVectors.axis ??= new THREE.Vector3()

        this.model.updateMatrixWorld(true)
        bone.getWorldPosition(pivot)
        bone.getWorldQuaternion(world)
        axis.set(0, 1, 0).applyQuaternion(world) // El eje Y del hueso va a lo largo del hueso
        this.indexFinger.bones[2].getWorldPosition(tip)

        // Proyectar en el plano perpendicular al eje
        from.subVectors(tip, pivot); from.addScaledVector(axis, - from.dot(axis))
        to.subVectors(this.smoothedTarget, pivot); to.addScaledVector(axis, - to.dot(axis))
        if(from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8)
            return

        let angle = Math.atan2(axis.dot(from.clone().cross(to)), from.dot(to))

        // Continuidad: atan2 salta de +180° a -180° cuando el mouse pasa "por detrás" del brazo
        // => se elige la vuelta más cercana al ángulo del frame anterior (si no llega, se queda en el límite del mismo lado)
        const previous = this.previousTwist ?? 0
        angle += Math.round((previous - angle) / (Math.PI * 2)) * Math.PI * 2
        angle = THREE.MathUtils.clamp(angle, - Math.PI * 1.5, Math.PI * 1.5)
        this.previousTwist = angle

        const limit = THREE.MathUtils.degToRad(maxTwist)
        delta.setFromAxisAngle(axis, THREE.MathUtils.clamp(angle * twist * this.aimAmount, - limit, limit))

        world.premultiply(delta)
        bone.parent.getWorldQuaternion(parent)
        bone.quaternion.copy(parent.invert().multiply(world))
    }

    // Punta del índice en mundo (el último hueso no tiene "cola": se extiende la falange distal)
    getIndexTip(target)
    {
        const [ , middle, distal ] = this.indexFinger.bones
        const start = this.aimVectors.from
        middle.getWorldPosition(start)
        distal.getWorldPosition(target)
        return target.add(start.subVectors(target, start).multiplyScalar(0.86)) // distal ≈ 0.86 x media (0.25 / 0.29)
    }

    update(elapsedTime, deltaTime)
    {
        // Estirarse: suavizado (rápido al acercarse, más lento al alejarse)
        const reachSpeed = this.reachTarget > this.reach ? 5 : 2.5
        this.reach += (this.reachTarget - this.reach) * (1 - Math.exp(- deltaTime * reachSpeed))
        this.setPose(elapsedTime)

        // Target suavizado (el dedo sigue al mouse con un poco de inercia)
        this.smoothedTarget.lerp(this.target, 1 - Math.exp(- deltaTime * 6))

        // Cercanía: la mano solo gira hacia el mouse cuando está cerca (suavizado)
        this.proximity += (this.proximityTarget - this.proximity) * (1 - Math.exp(- deltaTime * 4))
        this.aimAmount = this.aim * this.proximity

        if(this.aimAmount > 0.001)
        {
            this.aimTwist(this.forearm, this.aimJoints.forearm)
            this.aimBone(this.forearm, this.aimJoints.forearm)
            this.aimBone(this.wrist, this.aimJoints.wrist)
            this.aimBone(this.indexFinger.bones[0], this.aimJoints.index)
        }

        this.smoothAim(deltaTime)
    }

    // Las rotaciones de apuntar se acercan de a poco a las calculadas (nunca saltan de una posición a otra)
    smoothAim(deltaTime)
    {
        const bones = [ this.forearm, this.wrist, this.indexFinger.bones[0] ]
        // deltaTime limitado: después de una pausa (pestaña en segundo plano) tampoco salta
        const alpha = 1 - Math.exp(- Math.min(deltaTime, 1 / 30) * this.aimSmoothing)

        for(const bone of bones)
        {
            const smoothed = bone.userData.smoothedQuaternion ??= bone.quaternion.clone()
            smoothed.slerp(bone.quaternion, alpha)
            bone.quaternion.copy(smoothed)
        }
    }
}
