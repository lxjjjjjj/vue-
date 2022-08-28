// 几个要点

// 1.响应式系统的数据结构
// 2.嵌套的effect
// 3.分支清除deps
// 4.分支清除deps导致的无限循环effects执行
// 5.无限调用effect执行 obj.foo = obj.foo + 1

// computed注意的点
// 1.lazy计算 effect的lazyoptions决定
// 2.缓存值，在scheduler函数的执行后将dirty变成true重新计算取值
// 3.当我们在另外一个effect中读取计算属性值的时候，
//   它里面访问的响应式数据只会把computed内部的effect收集为依赖，
//   外层effect不会被内层effect中的响应式数据收集


// watch注意的点
// 1.immediate 立即执行
// 2.oldValue 和 newValue 的参数值
// 3.watch函数是否要销毁

// 代理Object要注意的点
// 1.响应系统应拦截一切读取操作 包括有 访问属性obj.foo、判断对象或者原型上是否存在给定的key、使用for...in循环遍历对象 for(const key in obj){}
// 2.


// 什么是副作用函数，一个函数执行直接或间接影响其他函数执行
// 在副作用函数中读取了某个响应式数据，响应式数据变化了，副作用函数要执行
const obj = new Proxy(data, {
    get(target, key, receiver){
        // 代理对象可以通过raw属性访问原始数据
        if(key === 'raw'){
            return target
        }
        track(target, key)
        // 使用Reflect.get是为了避免一下这种更改this属性的情况
        // const data = { // 实际调用get的时候 this是原始对象data 而不是 代理对象obj
        //     foo: 1,
        //     get bar(){
        //         return this.foo
        //     }
        // }
        return Reflect.get(target, key, receiver)
    },
    set(target, key, newVal,receiver){
        // 先获取旧值
        const oldValue = target[key]
        // 如果属性不存在，说明是添加新属性，否则就是设置已有属性
        const type = Object.prototype.hasOwnProperty.call(target, key) ? 'SET' : 'ADD'
        const res = Reflect.set(target, key, newVal,receiver)
        // 避免原型链访问子元素不存在的属性但是父元素存在属性，
        // 修改子元素数据，父元素属性也收集了一次effect函数依赖，导致effect执行两次的原因
        // 通过判断target是真正调用者recevier的原始数据判断是否要将effect函数收集到target的副作用依赖中
        // 从原型上继承属性的情况 示例
        // const obj = {}
        // const proto = { bar: 1 }
        // const child = reactive(obj)
        // const parent = reactive(proto)
        // Object.setPrototypeOf(child, parent)
        // effect(()=>{
        //     console.log(child.bar)
        // })
        // child.bar = 2
        if(target === receiver.raw){
            // 将 type 传给 trigger
            if(oldValue !== newValue && (oldValue === oldValue || newValue === newValue)){
                trigger(target, key , type)
            }
        }
        // 触发for...in的副作用执行
        // trigger(target, ITERATE_KEY)
        return res
    },
    // 拦截in操作符的读取
    has(target, key){
        track(target, key)
        return Reflect.get(target, key)
    },
    // 拦截for...in操作的读取
    // 当为target添加新的属性时，会对for...in循环产生影响，所以需要触发与ITERATE_KEY相关联的副作用函数重新执行
    // 但是当为对象添加新属性的时候，也只是触发了这个属性的副作用函数重新执行，
    // for...in循环是在副作用函数和ITERATE_KEY建立联系，这和新增加的属性一点关系也没有
    // 解决方案就是 当添加属性的时候，我们将与ITERATE_KEY关联的副作用函数取出来执行就好了 在trigger函数内解决
    ownKeys(target){
        // ownkeys 用来获取target上所有的key 明显不和任何key绑定，所以我们自己构造唯一的key做为标识
        track(target, ITERATE_KEY)
        return Reflect.ownKeys(target)
    },
    deleteProperty(target, key){
        // 检查被操作的属性是否是对象自己的属性
        const hadKey = Object.prototype.hasOwnProperty.call(target,key)
        const res = Reflect.defineProperty(target, key)

        if(res && hadKey) {
            // 只有当被删除的属性是自己的属性并且成功删除时 才触发更新
            trigger(target, key, 'DELETE')
        }

        return res
    }
})
let activeEffect
const effectStack = []
function effect(fn, options = {}) {
    const effectFn = () => {
        // 在每次effect函数执行之前都要清空effect的deps依赖，
        // deps内也清空effect以便于在effect执行的时候deps重新收集新的effects依赖
        // 减少不必要的更新 比如<div v-if="{{obj.show}}">{{obj.text}}</div>
        // 当obj.show变成false 就无需因为obj.text的更新而重新渲染了
        cleanup(effectFn)
        // 同一时刻用activeEffect做为全局变量存储的副作用函数只有一个，当副作用函数发生嵌套的时候
        // 内层副作用函数的执行会覆盖activeEffect值，不会恢复到原来的值
        // 如果再有响应式数据进行依赖收集
        // 即使这个响应式数据是在外层副作用函数中读取的，他们收集的副作用函数永远是内层副作用函数

        // effect嵌套案例 const data = { foo: 1, bar: 2 }
        // const obj = new Proxy(data, {/**/})
        // effect(function effectFn(){
        //     console.log('effectFn1')
        //     effect(function effectFn2(){
        //         console.log('effectFn2')
        //         temp2 = obj.bar
        //     })
        //     temp1 = obj.foo
        // })
        activeEffect = effectFn
        effectStack.push(effectFn)
        // 处理computed的getter拿到值的功能
        const res = fn()
        effectStack.pop()
        // 最后的effectStack内的元素永远都会是最外层的effect，因为此时最外层的effectFn()还没执行 
        activeEffect = effectStack[effectStack.length - 1]
        return res
    }
    effectFn.options = options
    effectFn.deps = []
    if(!options.lazy){
        effectFn()
    } else {
        return effectFn
    }
}
function cleanup(effectFn) {
    for(let i = 0;i < effectFn.deps.length;i++){
        const deps = effectFn.deps[i]
        deps.delete(effectFn)
    }
    effectFn.deps.length = 0
}
// effect 可以随便起名字不至于只能叫effect 也不限于是普通函数还是箭头函数
effect(() => {
    document.body.innerText = obj.text
},{
    scheduler(fn){
        setTimeout(fn)
    }
})
const bucket = new WeakMap()
// 所有响应式对象建立WeakMap的原因是因为如果WeakMap没有属性值被引用就会被js垃圾回收器回收
// WeakMap下是某个对象的Map Map下是Set结构收集所有effect函数，可以自然达到去重的效果
function track(target, key) {
    // 对象属性修改了才会执行收集依赖，否则没必要执行。因为表示没有地方用到对象及其属性
    if(!activeEffect) return 
    let depsMap = bucket.get(target)
    if(!depsMap){
        bucket.set(target, (depsMap = new Map()))
    }
    let deps = depsMap.get(key)
    if(!deps){
        deps.set(key, (deps = new Set()))
    }
    deps.add(activeEffect)
    activeEffect.deps.push(deps)
}
function trigger(target, key, type){
    const depsMap = bucket.get(target)
    if(!depsMap) return
    // 取得与key关联的副作用函数
    const effects = depsMap.get(key)
    // 取得与 ITERATE_KEY 相关联的副作用函数
    const iterateEffects = depsMap.get(ITERATE_KEY)
    // 新建一个effects数组是为了effect执行前清除依赖 ，effect执行后重新添加依赖会导致循环不断进行
    const effectsToRun = new Set()
    // 避免循环执行
    // effect(()=>{ obj.foo = obj.foo + 1})
    effects && effects.forEach(effectFn => {
        // 如果tigger触发执行的副作用函数与当前正在执行的副作用函数相同，则不触发执行
        if(effectFn !== activeEffect){
            effectsToRun.add(effectFn)
        }
    })
    // 只有操作类型是新添加属性的时候才会将 ITERATE_KEY 相关联的副作用函数也添加到 effectsToRun 中
    // 修改属性值，不需要重新执行for...in的副作用函数
    if(type === 'ADD' || type === 'DELETE'){
        iterateEffects && iterateEffects.forEach(effectFn => {
            if(effectFn !== activeEffect){
                effectsToRun.add(effectFn)
            }
        })
    }
    effectsToRun.forEach(effectFn => {
        if(effectFn.options.scheduler){
            effectFn.options.scheduler(effectFn)
        }else{
            effectFn()
        }
    })
}

// 实现 obj.foo++ obj.foo++ 只执行最后一次effect更新
const jobQueue = new Set()
const p = Promise.resolve()
let isFlushing = false
function flushJob(){
    if(isFlushing) return
    isFlushing = true
    p.then(()=>{
        jobQueue.forEach(job=>job())
    }).finally(()=>{
        isFlushing = false
    })
}

effect(()=>{
    console.log(obj.foo)
},{
    scheduler(fn){
        jobQueue.add(fn)
        flushJob()
    }
})

// obj.foo++
// obj.foo++
// 实际上flushJob只会在微任务队列执行一次，当微任务队列开始执行，就会遍历jobqueue里面的副作用函数，由于只有一个副作用函数所以只会执行一次

// 计算属性computed 和 lazy

effect(()=> {
    return obj.foo + obj.bar
},{
    lazy: true
})

function computed(getter) {
    // 用来缓存上一次的计算值
    let value
    // dirty 标志
    let dirty = true
    const effectFn = effect(getter, {
        lazy: true,
        // 当trigger函数触发，effect函数重新执行，表示数据有变化 将dirty变成true 可以重新获取新值
        scheduler(){
            if(!dirty){
                dirty = true
                // 手动触发调用计算属性的effect
                trigger(obj, 'value')
            }
        }
    })
    const obj = {
        get value(){
            if(dirty){
                value = effectFn()
                dirty = false
            }
            // 手动把调用计算属性的effect收集依赖
            track(obj, 'value')
            return value
        }
    }
    return obj
}

function watch(source, cb){
    let getter 
    if(typeof source === 'function'){
        getter = source
    } else {
        getter = () => traverse(source)
    }
    let oldValue,newValue
    const job = () => {
        newValue = effectFn()
        cb(newValue, oldValue)
        oldValue = newValue
    }
    const effectFn = effect(
        ()=> getter(source),
        {
            lazy: true,
            scheduler: () => {
                if(options.flush === 'post'){
                    const p = Promise.resolve()
                    p.then(job)
                }else{
                    job()
                }
            }
        }
    )
    if(options.immediate){
        job()
    }else{
        oldValue = effectFn()
    }
}
function traverse(value, seen = new Set()){
    if(typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    for(const k in value){
        traverse(value[k], seen)
    }
}
// 浅响应
function shallowReactive(obj){
    return new Proxy(obj, {/**/})
}
// 深响应
function reactive(obj){
    return new Proxy(obj, {
        get(target, key, recevier){
            if(key === 'raw'){
                return target
            }
            track(target,key)
            const res = Reflect.get(target, key, recevier)
            if(typeof res === 'object' && res !== null){
                return reactive(res)
            }
            return res
        }
    })
}
// 深浅响应结合
function createReactive(obj, isShallow = false, isReadonly = false){
    return new Proxy(obj, {
        get(target, key, recevier){
            if(key === 'raw'){
                return target
            }
            // 非只读才建立响应联系
            if(!isReadonly){
                track(target,key)
            }
            const res = Reflect.get(target, key, recevier)
            if(isShallow){
                return res
            }
            if(typeof res === 'object' && res !== null){
                return isReadonly ? readonly(res) : reactive(res)
            }
            return res
        },
        set(target, key, newVal, receiver){
            if(isReadonly) {
                console.warn(`属性${key}是只读的`)
                return true
            }
            const oldValue = target[key]
            const type = Object.prototype.hasOwnProperty.call(target, key) ? 'SET' : 'ADD'
            const res = Reflect.set(target, key, newVal,receiver)
            if(target === receiver.raw){
                if(oldValue !== newValue && (oldValue === oldValue || newValue === newValue)){
                    trigger(target, key , type)
                }
            }
            return res
        },
        deleteProperty(target, key){
            if(isReadonly) {
                console.warn(`属性${key}是只读的`)
                return true
            }
            const hadKey = Object.prototype.hasOwnProperty.call(target,key)
            const res = Reflect.defineProperty(target, key)
    
            if(res && hadKey) {
                trigger(target, key, 'DELETE')
            }
    
            return res
        }
    })
}

function readonly(obj){
    return createReactive(obj, false, true)
}
function shallowReadonly(obj){
    return createReactive(obj, true, true)
}