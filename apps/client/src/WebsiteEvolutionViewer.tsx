"use client";

import React, { useState, useRef, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sphere } from "@react-three/drei";
import { motion, AnimatePresence } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const formSchema = z.object({
  url: z.string().url({ message: "Please enter a valid URL" }),
  startYear: z.number().min(1900).max(new Date().getFullYear()),
  endYear: z.number().min(1900).max(new Date().getFullYear()),
  outputFileName: z
    .string()
    .min(1, { message: "Output file name is required" })
    .max(255),
});

type FormValues = z.infer<typeof formSchema>;

const currentYear = new Date().getFullYear();
const years = Array.from(
  { length: currentYear - 1899 },
  (_, i) => currentYear - i
);

function AnimatedSphere() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.position.y = Math.sin(state.clock.elapsedTime) * 0.2;
      meshRef.current.rotation.y += 0.01;
    }
  });

  return (
    <Sphere args={[1, 64, 64]} ref={meshRef}>
      <meshStandardMaterial color="#8352FD" metalness={0.7} roughness={0.2} />
    </Sphere>
  );
}

export default function WebsiteEvolutionViewer() {
  const [isLoading, setIsLoading] = useState(false);
  const [evolutionImages, setEvolutionImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      url: "",
      startYear: currentYear - 5,
      endYear: currentYear,
      outputFileName: "website_revolution",
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    try {
      const response = await fetch("http://localhost:3200/screenshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      setEvolutionImages(data.images);
      setCurrentImageIndex(0);
    } catch (error) {
      console.error("Error fetching website evolution:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const nextImage = () => {
    if (currentImageIndex < evolutionImages.length - 1) {
      setCurrentImageIndex((prev) => prev + 1);
    }
  };

  const prevImage = () => {
    if (currentImageIndex > 0) {
      setCurrentImageIndex((prev) => prev - 1);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto space-y-8">
      <div className="w-full h-64">
        <Canvas>
          <perspectiveCamera position={[0, 0, 5]} />
          <OrbitControls enableZoom={false} />
          <ambientLight intensity={0.5} />
          <directionalLight position={[10, 10, 10]} />
          <AnimatedSphere />
        </Canvas>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>URL</FormLabel>
                <FormControl>
                  <Input placeholder="https://example.com" {...field} />
                </FormControl>
                <FormDescription>
                  Enter the URL of the website you want to analyze.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="startYear"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start Year</FormLabel>
                <Select
                  onValueChange={(value) => field.onChange(parseInt(value))}
                  defaultValue={field.value.toString()}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a start year" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={year.toString()}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="endYear"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End Year</FormLabel>
                <Select
                  onValueChange={(value) => field.onChange(parseInt(value))}
                  defaultValue={field.value.toString()}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an end year" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={year.toString()}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="outputFileName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Output File Name</FormLabel>
                <FormControl>
                  <Input placeholder="website_evolution" {...field} />
                </FormControl>
                <FormDescription>
                  Enter the name for the output file (without extension).
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Loading..." : "Submit"}
          </Button>
        </form>
      </Form>

      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex justify-center items-center"
          >
            <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-indigo-500"></div>
          </motion.div>
        )}
      </AnimatePresence>

      {evolutionImages.length > 0 && (
        <div className="mt-8 space-y-4">
          <div className="relative h-64 bg-gray-200 rounded-lg overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.img
                key={currentImageIndex}
                src={evolutionImages[currentImageIndex]}
                alt={`Website evolution ${
                  form.getValues().startYear + currentImageIndex
                }`}
                className="w-full h-full object-cover"
                initial={{ opacity: 0, y: 50 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -50 }}
                transition={{ duration: 0.3 }}
              />
            </AnimatePresence>
            <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white p-2 text-center">
              Year: {form.getValues().startYear + currentImageIndex}
            </div>
          </div>
          <div className="flex justify-between">
            <Button
              onClick={prevImage}
              disabled={currentImageIndex === 0}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md disabled:opacity-50"
            >
              Previous
            </Button>
            <Button
              onClick={nextImage}
              disabled={currentImageIndex === evolutionImages.length - 1}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md disabled:opacity-50"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
