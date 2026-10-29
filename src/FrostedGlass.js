import * as THREE from 'three/webgpu'
import { Fn, mrt, output, positionWorld, rand, select, texture, uniform, uv, vec2, vec4, float, mix } from 'three/tsl'

/**
 * Frosted glass
 *
 * 1. Renderiza la escena "detrás del vidrio" en un RenderTarget con 2 salidas (MRT):
 *    - output: color de la mano (alpha = cobertura, el fondo queda transparente)
 *    - frost:  r = cobertura, g = distancia al vidrio normalizada (0 = tocando, 1 = lejos)
 * 2. Genera una pirámide de blur (cada nivel a la mitad de resolución) para ambas texturas a la vez:
 *    cada pasada escribe color y frost con MRT (12 pasadas en lugar de 24)
 * 3. Composita: por cada pixel estima la distancia y elige qué nivel de blur usar
 */
export default class FrostedGlass
{
    constructor(renderer, levels = 6)
    {
        this.renderer = renderer
        this.levels = levels

        this.quadMesh = new THREE.QuadMesh()
        this.size = new THREE.Vector2()
        this.rendererState = undefined

        // Uniforms
        this.glassZ = uniform(0)
        this.maxDistance = uniform(8) // Distancia a partir de la cual el blur es máximo
        this.maxLevel = uniform(levels) // Nivel de blur a la distancia máxima
        this.curve = uniform(0.87) // < 1: se borronea rápido al alejarse, > 1: lento
        this.scatter = uniform(0) // Ruido de dispersión (grano del esmerilado)
        this.farOpacity = uniform(0.205) // Opacidad de la silueta a la distancia máxima
        this.invResolution = uniform(new THREE.Vector2())

        this.setRenderTargets()
        this.setMRT()
        this.setBlurMaterials()
        this.setCompositeMaterial()
    }

    setRenderTargets()
    {
        // Scene
        this.sceneRenderTarget = new THREE.RenderTarget(1, 1, { count: 2, type: THREE.HalfFloatType, samples: 4 })
        this.sceneRenderTarget.textures[0].name = 'output'
        this.sceneRenderTarget.textures[1].name = 'frost'

        // Pyramid (color + frost en el mismo render target, MRT)
        const createLevel = () =>
        {
            const renderTarget = new THREE.RenderTarget(1, 1, { count: 2, type: THREE.HalfFloatType, depthBuffer: false })
            renderTarget.textures[0].name = 'output'
            renderTarget.textures[1].name = 'frost'
            return renderTarget
        }

        this.pyramid = {
            horizontal: [],
            vertical: []
        }

        for(let i = 0; i < this.levels; i++)
        {
            this.pyramid.horizontal.push(createLevel())
            this.pyramid.vertical.push(createLevel())
        }

        // Output
        this.outputRenderTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
        this.texture = this.outputRenderTarget.texture
    }

    setMRT()
    {
        const distance = positionWorld.z.sub(this.glassZ).negate().div(this.maxDistance).saturate()

        this.mrt = mrt({
            output: output,
            frost: vec4(1, distance, 0, 1)
        })
    }

    setBlurMaterials()
    {
        // Kernel gaussiano (sigma = 2 texels del nivel de destino)
        const radius = 5
        const sigma = 2
        const weights = []
        for(let i = 0; i <= radius; i++)
            weights.push(Math.exp(- 0.5 * i * i / (sigma * sigma)))
        const total = weights.reduce((sum, weight, i) => sum + (i === 0 ? weight : weight * 2), 0)
        for(let i = 0; i <= radius; i++)
            weights[i] /= total

        // Taps: [ offset en texels, peso ] (uno solo para el centro, después se suman de los dos lados)
        // Downsample (lee el nivel anterior, 2x más grande): offsets enteros del nivel de destino
        const downsampleTaps = weights.map((weight, i) => [ i, weight ])

        // Misma resolución: muestreo lineal => el filtro bilineal de la GPU suma dos texels vecinos en una sola lectura
        // (taps 1+2 y 3+4 juntos, el 5 solo): mismo resultado con 7 lecturas en lugar de 11
        const linearTaps = [ [ 0, weights[0] ] ]
        for(let i = 1; i <= radius; i += 2)
        {
            const weightA = weights[i]
            const weightB = i + 1 <= radius ? weights[i + 1] : 0
            linearTaps.push([ (i * weightA + (i + 1) * weightB) / (weightA + weightB), weightA + weightB ])
        }

        // Blur de color y frost en la misma pasada (MRT)
        const createMaterial = (colorTexture, frostTexture, direction, taps) =>
        {
            const invSize = uniform(new THREE.Vector2())

            // Expresión pura (sin toVar / addAssign: fuera de un Fn esas asignaciones no se emiten)
            const blur = (inputTexture) =>
            {
                let sum = texture(inputTexture, uv()).mul(taps[0][1])

                for(let i = 1; i < taps.length; i++)
                {
                    const [ offsetTexels, weight ] = taps[i]
                    const offset = direction.mul(invSize).mul(offsetTexels)
                    const sampleA = texture(inputTexture, uv().add(offset))
                    const sampleB = texture(inputTexture, uv().sub(offset))
                    sum = sum.add(sampleA.add(sampleB).mul(weight))
                }

                return sum
            }

            const material = new THREE.NodeMaterial()
            const color = blur(colorTexture)
            material.outputNode = color
            material.mrtNode = mrt({
                output: color,
                frost: blur(frostTexture)
            })
            material.invSize = invSize

            return material
        }

        this.pyramid.horizontalMaterials = []
        this.pyramid.verticalMaterials = []

        for(let i = 0; i < this.levels; i++)
        {
            // El horizontal lee el nivel anterior (2x más grande) => downsample + blur
            const input = i === 0 ? this.sceneRenderTarget : this.pyramid.vertical[i - 1]
            const horizontal = this.pyramid.horizontal[i]
            this.pyramid.horizontalMaterials.push(createMaterial(input.textures[0], input.textures[1], vec2(1, 0), downsampleTaps))
            this.pyramid.verticalMaterials.push(createMaterial(horizontal.textures[0], horizontal.textures[1], vec2(0, 1), linearTaps))
        }
    }

    setCompositeMaterial()
    {
        const levels = [ this.sceneRenderTarget, ...this.pyramid.vertical ]
        const colorTextures = levels.map(renderTarget => renderTarget.textures[0])
        const frostTextures = levels.map(renderTarget => renderTarget.textures[1])

        this.compositeMaterial = new THREE.NodeMaterial()
        this.compositeMaterial.fragmentNode = Fn(() =>
        {
            const screenUv = uv()

            // Distancia estimada
            // Se promedia la distancia de los pixeles de mano cercanos (pesando más los niveles finos),
            // así el borde de la mano se borronea igual que su interior y no aparecen halos
            const frost = vec4(0).toVar()
            frostTextures.forEach((frostTexture, i) =>
            {
                frost.addAssign(texture(frostTexture, screenUv).mul(Math.pow(0.5, i)))
            })
            const coverage = frost.r
            const distance = select(coverage.greaterThan(0.0001), frost.g.div(coverage), float(1)).saturate()

            // Nivel de blur
            const level = distance.pow(this.curve).mul(this.maxLevel)

            // Dispersión (el esmerilado desvía cada pixel un poco al azar, más cuanto más lejos)
            const noise = vec2(
                rand(screenUv),
                rand(screenUv.add(17.31))
            ).sub(0.5)
            const jitter = noise.mul(this.scatter).mul(level.exp2()).mul(this.invResolution)
            const colorUv = screenUv.add(jitter)

            // Mezcla entre los 2 niveles más cercanos
            const color = vec4(0).toVar()
            colorTextures.forEach((colorTexture, i) =>
            {
                const weight = level.sub(i).abs().oneMinus().max(0)
                color.addAssign(texture(colorTexture, colorUv).mul(weight))
            })

            // Des-premultiplicar y atenuar con la distancia
            const alpha = color.a
            const rgb = color.rgb.div(alpha.max(0.0001))
            const opacity = alpha.mul(mix(1, this.farOpacity, distance)).saturate()

            return vec4(rgb, opacity)
        })()
    }

    setSize(width, height)
    {
        this.sceneRenderTarget.setSize(width, height)
        this.outputRenderTarget.setSize(width, height)
        this.invResolution.value.set(1 / width, 1 / height)

        const pyramid = this.pyramid
        for(let i = 0; i < this.levels; i++)
        {
            const levelWidth = Math.max(1, Math.floor(width / Math.pow(2, i + 1)))
            const levelHeight = Math.max(1, Math.floor(height / Math.pow(2, i + 1)))

            pyramid.horizontal[i].setSize(levelWidth, levelHeight)
            pyramid.vertical[i].setSize(levelWidth, levelHeight)
            pyramid.horizontalMaterials[i].invSize.value.set(1 / levelWidth, 1 / levelHeight)
            pyramid.verticalMaterials[i].invSize.value.set(1 / levelWidth, 1 / levelHeight)
        }
    }

    render(scene, camera)
    {
        const renderer = this.renderer

        // Reset
        this.rendererState = THREE.RendererUtils.resetRendererState(renderer, this.rendererState)

        // Size
        const width = this.size.x
        const height = this.size.y
        renderer.getDrawingBufferSize(this.size)
        if(this.size.x !== width || this.size.y !== height)
            this.setSize(this.size.x, this.size.y)

        // Scene (fondo transparente => alpha = cobertura)
        renderer.setClearColor(0x000000, 0)
        renderer.setMRT(this.mrt)
        renderer.setRenderTarget(this.sceneRenderTarget)
        renderer.render(scene, camera)
        renderer.setMRT(null)

        // Pyramid (color + frost a la vez)
        const pyramid = this.pyramid
        for(let i = 0; i < this.levels; i++)
        {
            renderer.setRenderTarget(pyramid.horizontal[i])
            this.quadMesh.material = pyramid.horizontalMaterials[i]
            this.quadMesh.render(renderer)

            renderer.setRenderTarget(pyramid.vertical[i])
            this.quadMesh.material = pyramid.verticalMaterials[i]
            this.quadMesh.render(renderer)
        }

        // Composite
        renderer.setRenderTarget(this.outputRenderTarget)
        this.quadMesh.material = this.compositeMaterial
        this.quadMesh.render(renderer)

        // Restore
        THREE.RendererUtils.restoreRendererState(renderer, this.rendererState)
    }
}
