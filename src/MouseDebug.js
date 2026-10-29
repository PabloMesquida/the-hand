import * as THREE from 'three/webgpu'

/**
 * Mouse debug
 *
 * Capa 2D sobre el canvas con:
 * - el cursor y sus coordenadas (px y NDC)
 * - la muñeca con los círculos de aimNear / aimFar (cuándo gira la mano)
 * - la punta del índice con los círculos de reachNear / reachFar (cuándo se estiran los dedos) * - distancias, proximity y reach
 * + una esfera 3D en el punto al que apunta el índice (target suavizado)
 *
 * Las distancias se miden en NDC con x * aspect => en píxeles: radio = distancia * alto / 2
 */
export default class MouseDebug
{
    constructor(scene)
    {
        this.visible = true

        // Canvas 2D
        this.canvas = document.createElement('canvas')
        this.canvas.style.cssText = 'position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;'
        document.body.appendChild(this.canvas)
        this.context = this.canvas.getContext('2d')

        // Target 3D
        this.targetMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 16, 12),
            new THREE.MeshBasicNodeMaterial({ color: '#ff2d55' })
        )
        scene.add(this.targetMesh)
    }

    // NDC (-1..1) => píxeles
    toPixels(ndc, width, height)
    {
        return { x: (ndc.x * 0.5 + 0.5) * width, y: (- ndc.y * 0.5 + 0.5) * height }
    }

    update({ cursor, wrist, tip, target, options, wristDistance, tipDistance, proximity, reach, sizes, show3D })
    {
        this.targetMesh.visible = this.visible && show3D
        this.targetMesh.position.copy(target)

        const { width, height } = sizes
        const pixelRatio = Math.min(window.devicePixelRatio, 2)
        if(this.canvas.width !== width * pixelRatio || this.canvas.height !== height * pixelRatio)
        {
            this.canvas.width = width * pixelRatio
            this.canvas.height = height * pixelRatio
        }

        const context = this.context
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
        context.clearRect(0, 0, width, height)
        if(!this.visible)
            return

        const radius = (distance) => distance * height * 0.5
        const circle = (center, distance, color, dashed) =>
        {
            context.beginPath()
            context.setLineDash(dashed ? [ 6, 6 ] : [])
            context.strokeStyle = color
            context.arc(center.x, center.y, radius(distance), 0, Math.PI * 2)
            context.stroke()
        }
        const dot = (point, color, size = 4) =>
        {
            context.beginPath()
            context.setLineDash([])
            context.fillStyle = color
            context.arc(point.x, point.y, size, 0, Math.PI * 2)
            context.fill()
        }
        const line = (from, to, color) =>
        {
            context.beginPath()
            context.setLineDash([ 2, 4 ])
            context.strokeStyle = color
            context.moveTo(from.x, from.y)
            context.lineTo(to.x, to.y)
            context.stroke()
        }

        const cursorPixels = this.toPixels(cursor, width, height)
        const wristPixels = this.toPixels(wrist, width, height)
        const tipPixels = this.toPixels(tip, width, height)

        context.lineWidth = 1.5

        // Muñeca: rango de giro (aim)
        circle(wristPixels, options.aimFar, 'rgba(80, 170, 255, 0.5)', true)
        circle(wristPixels, options.aimNear, 'rgba(80, 170, 255, 0.9)', false)
        dot(wristPixels, '#50aaff')

        // Punta del índice: rango de estiramiento (reach)
        circle(tipPixels, options.reachFar, 'rgba(255, 190, 60, 0.5)', true)
        circle(tipPixels, options.reachNear, 'rgba(255, 190, 60, 0.9)', false)
        dot(tipPixels, '#ffbe3c')
        // Cursor
        line(cursorPixels, wristPixels, 'rgba(80, 170, 255, 0.6)')
        line(cursorPixels, tipPixels, 'rgba(255, 190, 60, 0.6)')
        context.setLineDash([])
        context.strokeStyle = '#ff2d55'
        context.beginPath()
        context.moveTo(cursorPixels.x - 10, cursorPixels.y); context.lineTo(cursorPixels.x + 10, cursorPixels.y)
        context.moveTo(cursorPixels.x, cursorPixels.y - 10); context.lineTo(cursorPixels.x, cursorPixels.y + 10)
        context.stroke()

        // Texto
        const lines = [
            `mouse px  ${ Math.round(cursorPixels.x) }, ${ Math.round(cursorPixels.y) }`,
            `mouse ndc ${ cursor.x.toFixed(2) }, ${ cursor.y.toFixed(2) }`,
            `muñeca    dist ${ wristDistance.toFixed(2) }  proximity ${ proximity.toFixed(2) }`,
            `índice    dist ${ tipDistance.toFixed(2) }  reach ${ reach.toFixed(2) }`,
            `target    ${ target.x.toFixed(2) }, ${ target.y.toFixed(2) }, ${ target.z.toFixed(2) }`
        ]
        context.font = '12px monospace'
        context.fillStyle = 'rgba(0, 0, 0, 0.55)'
        context.fillRect(12, 12, 330, lines.length * 16 + 12)
        context.fillStyle = '#ffffff'
        lines.forEach((text, i) => context.fillText(text, 20, 30 + i * 16))
    }
}
