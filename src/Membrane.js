import * as THREE from 'three/webgpu'
import { Fn, deltaTime, exp, float, instanceIndex, ivec2, select, smoothstep, storageTexture, texture, uniform, vec2, vec4 } from 'three/tsl'

/**
 * Membrane (spandex)
 *
 * Basado en la lección de la nieve:
 * 1. Una cámara ortográfica del lado de la cámara mira el vidrio (z = 0) y renderiza la profundidad de la mano
 *    => cuánto atraviesa la mano el plano del vidrio (push)
 * 2. Compute (jump flooding): cada texel busca el punto de contacto que más lo levanta
 *    => la tela forma "carpas" redondas alrededor de los puntos de contacto, con crestas entre dedos
 * 3. Compute: suavizado + un resorte lleva la altura visible hacia ese objetivo (elasticidad, rebote al soltar)
 */
export default class Membrane
{
    constructor(renderer, size = 10, resolution = 256)
    {
        this.renderer = renderer
        this.size = size
        this.resolution = resolution
        this.texelSize = size / resolution
        this.rendererState = undefined

        this.maxPush = 2 // Lo máximo que la mano puede atravesar el vidrio
        this.smoothIterations = 4

        // Uniforms
        this.slope = uniform(2.536) // Tensión: más alto = carpas más angostas
        this.profile = uniform(1.59) // Forma de la carpa: 1 = cono, > 1 = pie más suave
        this.stiffness = uniform(10)
        this.damping = uniform(6.39)
        this.enabled = true
        this.strength = uniform(1) // 0 = vidrio plano (membrana apagada)

        this.setDepth()
        this.setTextures()
        this.setComputes()
    }

    setDepth()
    {
        const halfSize = this.size * 0.5
        const near = 1

        // Camera (mira hacia -z, el plano lejano coincide con el vidrio)
        this.depthCamera = new THREE.OrthographicCamera(- halfSize, halfSize, halfSize, - halfSize, near, near + this.maxPush)
        this.depthCamera.position.z = near + this.maxPush
        this.depthCamera.updateMatrixWorld()

        // RenderTarget
        this.depthRenderTarget = new THREE.RenderTarget(this.resolution, this.resolution)
        this.depthRenderTarget.depthTexture = new THREE.DepthTexture()

        // Depth material
        this.depthMaterial = new THREE.NodeMaterial()
        this.depthMaterial.fragmentNode = vec4(0, 0, 0, 1)
    }

    setTextures()
    {
        const createTexture = () =>
        {
            const storage = new THREE.StorageTexture(this.resolution, this.resolution)
            storage.format = THREE.RedFormat
            storage.type = THREE.FloatType
            return storage
        }

        this.pushTexture = createTexture() // Cuánto atraviesa la mano el vidrio
        this.sourceTexture = createTexture() // Índice del punto de contacto que más levanta cada texel (-1 = ninguno)
        this.targetTexture = createTexture() // Forma objetivo
        this.heightTexture = createTexture() // Altura actual (la que se ve)
        this.velocityTexture = createTexture()
    }

    setComputes()
    {
        const resolution = this.resolution
        const count = resolution * resolution

        const pushNode = storageTexture(this.pushTexture).setAccess(THREE.NodeAccess.READ_WRITE)
        const sourceNode = storageTexture(this.sourceTexture).setAccess(THREE.NodeAccess.READ_WRITE)
        const targetNode = storageTexture(this.targetTexture).setAccess(THREE.NodeAccess.READ_WRITE)
        const heightNode = storageTexture(this.heightTexture).setAccess(THREE.NodeAccess.READ_WRITE)
        const velocityNode = storageTexture(this.velocityTexture).setAccess(THREE.NodeAccess.READ_WRITE)

        const getIndex = () => ivec2(instanceIndex.mod(resolution), instanceIndex.div(resolution))
        const clampIndex = (index) => index.clamp(ivec2(0), ivec2(resolution - 1))

        // Altura que un punto de contacto (source) le da al texel index
        const getElevation = (source, index) =>
        {
            const sourceIndex = ivec2(source.max(0).mod(resolution), source.max(0).div(resolution).floor())
            const push = pushNode.load(sourceIndex).r
            const distance = vec2(sourceIndex.sub(index)).length().mul(this.texelSize)
            const radius = push.div(this.slope)
            const progress = distance.div(radius).saturate()
            const elevation = push.mul(progress.oneMinus().pow(this.profile))

            return select(source.lessThan(0), float(- 1), elevation)
        }

        // Push
        this.pushCompute = Fn(() =>
        {
            const index = getIndex()
            const textureUv = vec2(index).add(0.5).div(resolution)
            const depth = texture(this.depthRenderTarget.depthTexture, vec2(textureUv.x, textureUv.y.oneMinus())).r
            const push = depth.oneMinus().mul(this.maxPush)
            const source = select(push.greaterThan(0.001), float(instanceIndex), float(- 1))

            pushNode.store(index, vec4(push, 0, 0, 0))
            sourceNode.store(index, vec4(source, 0, 0, 0))
        })().compute(count)

        // Jump flooding (pasos 64, 32, ... 1 + uno extra de 1 para corregir errores)
        this.jumpFloodComputes = []
        const steps = []
        for(let step = resolution / 4; step >= 1; step /= 2)
            steps.push(step)
        steps.push(1)

        for(const step of steps)
        {
            const jumpFloodCompute = Fn(() =>
            {
                const index = getIndex()
                const bestSource = sourceNode.load(index).r.toVar()
                const bestElevation = getElevation(bestSource, index).toVar()

                for(const [x, y] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ], [ 1, 1 ], [ - 1, 1 ], [ 1, - 1 ], [ - 1, - 1 ] ])
                {
                    const neighborIndex = clampIndex(index.add(ivec2(x * step, y * step)))
                    const candidate = sourceNode.load(neighborIndex).r
                    const elevation = getElevation(candidate, index)
                    const isBetter = elevation.greaterThan(bestElevation)

                    bestSource.assign(select(isBetter, candidate, bestSource))
                    bestElevation.assign(select(isBetter, elevation, bestElevation))
                }

                sourceNode.store(index, vec4(bestSource, 0, 0, 0))
            })().compute(count)

            this.jumpFloodComputes.push(jumpFloodCompute)
        }

        // Target (altura a partir del mejor punto de contacto)
        this.targetCompute = Fn(() =>
        {
            const index = getIndex()
            const elevation = getElevation(sourceNode.load(index).r, index).max(0)

            targetNode.store(index, vec4(elevation, 0, 0, 0))
        })().compute(count)

        // Smooth
        this.smoothCompute = Fn(() =>
        {
            const index = getIndex()
            const height = targetNode.load(index).r
                .add(targetNode.load(clampIndex(index.add(ivec2(1, 0)))).r)
                .add(targetNode.load(clampIndex(index.add(ivec2(- 1, 0)))).r)
                .add(targetNode.load(clampIndex(index.add(ivec2(0, 1)))).r)
                .add(targetNode.load(clampIndex(index.add(ivec2(0, - 1)))).r)
                .div(5)

            targetNode.store(index, vec4(height, 0, 0, 0))
        })().compute(count)

        // Spring (la altura visible persigue al objetivo con elasticidad)
        this.springCompute = Fn(() =>
        {
            const index = getIndex()
            const textureUv = vec2(index).add(0.5).div(resolution)

            // Los bordes quedan fijos (como un bastidor)
            const edgeDistance = textureUv.min(textureUv.oneMinus())
            const edgeMask = smoothstep(0, 0.08, edgeDistance.x.min(edgeDistance.y))

            const target = targetNode.load(index).r.mul(edgeMask)
            const height = heightNode.load(index).r
            const velocity = velocityNode.load(index).r

            const clampedDeltaTime = deltaTime.min(1 / 30)
            const newVelocity = velocity
                .add(target.sub(height).mul(this.stiffness).mul(clampedDeltaTime))
                .mul(exp(this.damping.negate().mul(clampedDeltaTime)))
            const newHeight = height.add(newVelocity.mul(clampedDeltaTime))

            heightNode.store(index, vec4(newHeight, 0, 0, 0))
            velocityNode.store(index, vec4(newVelocity, 0, 0, 0))
        })().compute(count)

        this.computes = [
            this.pushCompute,
            ...this.jumpFloodComputes,
            this.targetCompute,
            ...new Array(this.smoothIterations).fill(this.smoothCompute),
            this.springCompute
        ]
    }

    // Altura de la tela en una posición (x, y) del mundo
    heightAt(position)
    {
        return texture(this.heightTexture, position.div(this.size).add(0.5)).r.mul(this.strength)
    }

    setEnabled(enabled)
    {
        this.enabled = enabled
        this.strength.value = enabled ? 1 : 0
    }

    update(scene)
    {
        const renderer = this.renderer

        // Reset
        this.rendererState = THREE.RendererUtils.resetRendererState(renderer, this.rendererState)

        // Render depth
        scene.overrideMaterial = this.depthMaterial
        renderer.setRenderTarget(this.depthRenderTarget)
        renderer.render(scene, this.depthCamera)

        // Restore
        scene.overrideMaterial = null
        THREE.RendererUtils.restoreRendererState(renderer, this.rendererState)

        // Compute
        renderer.compute(this.computes)
    }
}
